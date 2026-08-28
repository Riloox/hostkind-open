'use strict';

/*
 * Migration runner for the platform foundation.
 *
 * Spec contract (docs/roadmap/README.md "Shared platform foundation"):
 *   - "Run numbered migrations in one transaction each and record them in
 *      schema_migrations(version, name, applied_at)."
 *   - "Before migrating, make a consistent database snapshot and retain the
 *      newest three. A migration failure leaves the prior version usable."
 *   - "Import metrics.json once, without deleting or rewriting it. Record the
 *      import key in data_imports; duplicate runs are no-ops."
 *
 * Each migration is a (version, name, up(db) => void) entry. They run in
 * version order inside their own transaction. The runner snapshots the .db
 * file (not the live connection) to a timestamped copy in data/snapshots/
 * before applying, keeps the newest three, and rolls back the schema changes
 * of a failed migration by reverting to the prior snapshot copy.
 *
 * The snapshot is a plain file copy of the SQLite file. It must happen while
 * the connection is idle and no writes are in flight; the runner wraps the
 * snapshot in a short "synchronized" critical section.
 */

const fs = require('fs');
const path = require('path');
const { open, close, dbPath, dataDir } = require('./db.cjs');

const MIGRATIONS = [
  {
    version: 1,
    name: 'foundation-schema',
    up(db) {
      // schema_migrations: tracks applied migrations.
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version    INTEGER PRIMARY KEY,
          name       TEXT    NOT NULL,
          applied_at INTEGER NOT NULL
        );

        -- data_imports: idempotency keys for one-shot imports (e.g. metrics.json).
        CREATE TABLE IF NOT EXISTS data_imports (
          key         TEXT    PRIMARY KEY,
          imported_at INTEGER NOT NULL,
          summary     TEXT    NOT NULL
        );

        -- audit_events: append-only audit log.
        CREATE TABLE IF NOT EXISTS audit_events (
          id           TEXT    PRIMARY KEY,
          ts           INTEGER NOT NULL,
          actor_id     TEXT,
          server_id    TEXT,
          action       TEXT    NOT NULL,
          target       TEXT,
          outcome      TEXT    NOT NULL,
          request_id   TEXT,
          operation_id TEXT,
          metadata     TEXT
        );
        CREATE INDEX IF NOT EXISTS audit_events_ts_idx     ON audit_events(ts);
        CREATE INDEX IF NOT EXISTS audit_events_actor_idx  ON audit_events(actor_id);
        CREATE INDEX IF NOT EXISTS audit_events_server_idx ON audit_events(server_id);
        CREATE INDEX IF NOT EXISTS audit_events_action_idx ON audit_events(action);

        -- capability_grants: per-(user,server,capability) grants. No wildcards.
        -- server_id IS NULL means "server-agnostic" (e.g. global capabilities).
        CREATE TABLE IF NOT EXISTS capability_grants (
          user_id    TEXT    NOT NULL,
          server_id  TEXT,
          capability TEXT    NOT NULL,
          granted_at INTEGER NOT NULL,
          granted_by TEXT,
          PRIMARY KEY (user_id, server_id, capability)
        );
        CREATE INDEX IF NOT EXISTS capability_grants_user_idx   ON capability_grants(user_id);
        CREATE INDEX IF NOT EXISTS capability_grants_server_idx ON capability_grants(server_id);

        -- operations: durable operations (the "long mutation" primitive).
        CREATE TABLE IF NOT EXISTS operations (
          id              TEXT    PRIMARY KEY,
          kind            TEXT    NOT NULL,
          state           TEXT    NOT NULL,
          phase           TEXT,
          progress        REAL,
          heartbeat       INTEGER,
          summary         TEXT,
          journal         TEXT,
          actor_id        TEXT,
          server_id       TEXT,
          idempotency_key TEXT,
          queued_at       INTEGER NOT NULL,
          started_at      INTEGER,
          finished_at     INTEGER,
          error_code      TEXT,
          error_text      TEXT,
          recovery        TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS operations_idem_idx
          ON operations(actor_id, idempotency_key)
          WHERE idempotency_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS operations_server_state_idx
          ON operations(server_id, state, queued_at);
        CREATE INDEX IF NOT EXISTS operations_state_idx
          ON operations(state);

        -- operation_events: append-only timeline for an operation.
        CREATE TABLE IF NOT EXISTS operation_events (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          operation_id TEXT    NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
          ts          INTEGER NOT NULL,
          phase       TEXT,
          message     TEXT,
          level       TEXT,
          metadata    TEXT
        );
        CREATE INDEX IF NOT EXISTS operation_events_op_ts_idx
          ON operation_events(operation_id, ts);

        -- snapshots: pre-mutation snapshots taken against a server folder.
        -- path is relative to data/snapshots/.
        CREATE TABLE IF NOT EXISTS snapshots (
          id          TEXT    PRIMARY KEY,
          server_id   TEXT    NOT NULL,
          kind        TEXT    NOT NULL,
          path        TEXT    NOT NULL,
          size        INTEGER NOT NULL,
          file_count  INTEGER NOT NULL,
          taken_at    INTEGER NOT NULL,
          verified    INTEGER NOT NULL DEFAULT 0,
          reason      TEXT
        );
        CREATE INDEX IF NOT EXISTS snapshots_server_taken_idx
          ON snapshots(server_id, taken_at DESC);

        -- Legacy metrics imported from metrics.json. The five-value tuple is
        -- preserved without rewriting the source file.
        CREATE TABLE IF NOT EXISTS metric_samples (
          server_id TEXT    NOT NULL,
          ts        INTEGER NOT NULL,
          cpu       REAL,
          memory_mb REAL,
          players   INTEGER,
          world_mb  REAL,
          PRIMARY KEY (server_id, ts)
        );
        CREATE INDEX IF NOT EXISTS metric_samples_server_ts_idx
          ON metric_samples(server_id, ts DESC);
      `);
    },
  },
  {
    version: 2,
    name: 'metrics-and-capability-integrity',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS metric_samples (
          server_id TEXT    NOT NULL,
          ts        INTEGER NOT NULL,
          cpu       REAL,
          memory_mb REAL,
          players   INTEGER,
          world_mb  REAL,
          PRIMARY KEY (server_id, ts)
        );
        CREATE INDEX IF NOT EXISTS metric_samples_server_ts_idx
          ON metric_samples(server_id, ts DESC);
        DELETE FROM capability_grants
         WHERE rowid NOT IN (
           SELECT MIN(rowid) FROM capability_grants
            GROUP BY user_id, COALESCE(server_id, ''), capability
         );
        CREATE UNIQUE INDEX IF NOT EXISTS capability_grants_exact_idx
          ON capability_grants(user_id, COALESCE(server_id, ''), capability);
      `);
    },
  },
  {
    version: 3,
    name: 'crash-intelligence',
    up(db) {
      db.exec(`
        CREATE TABLE crash_groups (
          id TEXT PRIMARY KEY, server_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
          category TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
          count INTEGER NOT NULL DEFAULT 1, acknowledged_at INTEGER, acknowledged_by TEXT,
          UNIQUE(server_id, fingerprint)
        );
        CREATE INDEX crash_groups_last_seen_idx ON crash_groups(last_seen_at DESC);
        CREATE TABLE crash_incidents (
          id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES crash_groups(id) ON DELETE CASCADE,
          server_id TEXT NOT NULL, exit_code INTEGER, signal TEXT, occurred_at INTEGER NOT NULL,
          runtime_ms INTEGER, evidence_json TEXT NOT NULL, environment_json TEXT NOT NULL
        );
        CREATE INDEX crash_incidents_group_time_idx ON crash_incidents(group_id, occurred_at DESC);
        CREATE TABLE crash_conclusions (
          id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES crash_incidents(id) ON DELETE CASCADE,
          rule_id TEXT NOT NULL, category TEXT NOT NULL, confidence TEXT NOT NULL,
          reasoning_json TEXT NOT NULL, suggestions_json TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 4,
    name: 'safe-update-center',
    up(db) {
      db.exec(`
        CREATE TABLE content_provenance (
          id TEXT PRIMARY KEY, server_id TEXT NOT NULL, relative_path TEXT NOT NULL,
          kind TEXT NOT NULL, provider TEXT NOT NULL, project_id TEXT NOT NULL,
          version_id TEXT NOT NULL, mc_version TEXT, loader TEXT, sha256 TEXT NOT NULL,
          managed_at INTEGER NOT NULL, UNIQUE(server_id, relative_path)
        );
        CREATE INDEX content_provenance_server_idx ON content_provenance(server_id);
        CREATE TABLE compatibility_cache (
          source TEXT NOT NULL, cache_key TEXT NOT NULL, retrieved_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL, stale INTEGER NOT NULL DEFAULT 0,
          payload_json TEXT, error_json TEXT, PRIMARY KEY(source, cache_key)
        );
        CREATE TABLE update_plans (
          id TEXT PRIMARY KEY, server_id TEXT NOT NULL, created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL, base_inventory_hash TEXT NOT NULL,
          status TEXT NOT NULL, plan_json TEXT NOT NULL
        );
        CREATE INDEX update_plans_server_time_idx ON update_plans(server_id, created_at DESC);
      `);
    },
  },
  {
    version: 5,
    name: 'modpack-lifecycle',
    up(db) {
      db.exec(`
        CREATE TABLE modpack_manifests (
          id TEXT PRIMARY KEY, server_id TEXT NOT NULL, provider TEXT NOT NULL,
          project_id TEXT NOT NULL, version_id TEXT NOT NULL, mc_version TEXT NOT NULL,
          loader TEXT NOT NULL, installed_at INTEGER NOT NULL, operation_id TEXT NOT NULL,
          manifest_hash TEXT NOT NULL, snapshot_id TEXT, previous_manifest_id TEXT,
          FOREIGN KEY(previous_manifest_id) REFERENCES modpack_manifests(id)
        );
        CREATE INDEX modpack_manifests_server_time_idx
          ON modpack_manifests(server_id, installed_at DESC);
        CREATE TABLE modpack_files (
          manifest_id TEXT NOT NULL REFERENCES modpack_manifests(id) ON DELETE CASCADE,
          relative_path TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
          source_url_hash TEXT, ownership TEXT NOT NULL,
          PRIMARY KEY(manifest_id, relative_path)
        );
        CREATE TABLE modpack_conflict_decisions (
          operation_id TEXT NOT NULL, relative_path TEXT NOT NULL,
          decision TEXT NOT NULL CHECK(decision IN ('keep_local', 'take_pack')),
          actor_id TEXT NOT NULL, PRIMARY KEY(operation_id, relative_path)
        );
        CREATE TABLE modpack_previews (
          id TEXT PRIMARY KEY, server_id TEXT NOT NULL, actor_id TEXT NOT NULL,
          kind TEXT NOT NULL, project_id TEXT NOT NULL, version_id TEXT NOT NULL,
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
          inventory_hash TEXT NOT NULL, payload_json TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 6,
    name: 'recovery-confidence',
    up(db) {
      db.exec(`
        CREATE TABLE backup_manifests (
          id TEXT PRIMARY KEY, server_id TEXT NOT NULL, filename TEXT NOT NULL UNIQUE,
          size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL,
          inventory_json TEXT NOT NULL, world_roots_json TEXT NOT NULL
        );
        CREATE INDEX backup_manifests_server_time_idx ON backup_manifests(server_id, created_at DESC);
        CREATE TABLE backup_verifications (
          id TEXT PRIMARY KEY, backup_id TEXT NOT NULL REFERENCES backup_manifests(id) ON DELETE CASCADE,
          operation_id TEXT, status TEXT NOT NULL, crc_ok INTEGER NOT NULL DEFAULT 0,
          sha256 TEXT, verified_at INTEGER NOT NULL, error_code TEXT
        );
        CREATE INDEX backup_verifications_backup_time_idx ON backup_verifications(backup_id, verified_at DESC);
        CREATE TABLE backup_drills (
          id TEXT PRIMARY KEY, backup_id TEXT NOT NULL REFERENCES backup_manifests(id) ON DELETE CASCADE,
          operation_id TEXT, status TEXT NOT NULL, started_at INTEGER NOT NULL,
          completed_at INTEGER, report_json TEXT
        );
        CREATE INDEX backup_drills_backup_time_idx ON backup_drills(backup_id, started_at DESC);
        CREATE TABLE backup_previews (
          token TEXT PRIMARY KEY, backup_id TEXT NOT NULL REFERENCES backup_manifests(id) ON DELETE CASCADE,
          server_id TEXT NOT NULL, actor_id TEXT NOT NULL, created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL, server_fingerprint TEXT NOT NULL, payload_json TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 7,
    name: 'audit-trail',
    up(db) {
      const columns = new Set(db.prepare('PRAGMA table_info(audit_events)').all().map((row) => row.name));
      const additions = [
        ['actor_username', 'TEXT'],
        ['target_type', 'TEXT'],
        ['target_id', 'TEXT'],
      ];
      for (const [name, type] of additions) {
        if (!columns.has(name)) db.exec(`ALTER TABLE audit_events ADD COLUMN ${name} ${type}`);
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS audit_events_ts_id_idx ON audit_events(ts DESC, id DESC);
        CREATE INDEX IF NOT EXISTS audit_events_server_ts_idx ON audit_events(server_id, ts DESC);
        CREATE INDEX IF NOT EXISTS audit_events_actor_ts_idx ON audit_events(actor_id, ts DESC);
        CREATE INDEX IF NOT EXISTS audit_events_action_ts_idx ON audit_events(action, ts DESC);
        CREATE TABLE IF NOT EXISTS audit_retention_previews (
          token TEXT PRIMARY KEY,
          actor_id TEXT NOT NULL,
          cutoff INTEGER NOT NULL,
          event_count INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS audit_retention_requests (
          actor_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          result_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (actor_id, idempotency_key)
        );
      `);
    },
  },
  {
    version: 11,
    name: 'game-backup-metadata',
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS backup_game_metadata (
        backup_id TEXT PRIMARY KEY REFERENCES backup_manifests(id) ON DELETE CASCADE,
        metadata_json TEXT NOT NULL
      )`);
    },
  },
  {
    version: 8,
    name: 'health-and-capacity',
    up(db) {
      // metric_samples predates this feature and already stores MB-denominated
      // columns imported from metrics.json. Keep that unit convention (adding
      // *_mb columns) rather than renaming, so the one-shot import stays valid
      // and old rows keep their meaning.
      const columns = new Set(db.prepare('PRAGMA table_info(metric_samples)').all().map((row) => row.name));
      const additions = [
        ['tps', 'REAL'],
        ['online', 'INTEGER'],     // 1 = server process was up; null on legacy rows
        ['heap_mb', 'REAL'],       // configured -Xmx at sample time (null = unknown)
        ['disk_used_mb', 'REAL'],  // filesystem holding the server folder
        ['disk_total_mb', 'REAL'], // null = capacity could not be read
      ];
      for (const [name, type] of additions) {
        if (!columns.has(name)) db.exec(`ALTER TABLE metric_samples ADD COLUMN ${name} ${type}`);
      }
      db.exec(`
        -- Hourly rollups keep long windows queryable after raw samples age out.
        CREATE TABLE IF NOT EXISTS metric_rollups (
          server_id    TEXT    NOT NULL,
          bucket_ts    INTEGER NOT NULL,
          sample_count INTEGER NOT NULL,
          cpu_avg      REAL, cpu_max      REAL,
          memory_avg   REAL, memory_max   REAL,
          players_avg  REAL, players_max  REAL,
          world_avg    REAL,
          tps_avg      REAL, tps_min      REAL,
          disk_used_avg REAL, disk_total_avg REAL,
          PRIMARY KEY (server_id, bucket_ts)
        );

        -- Reproducible summaries: value_json holds the exact numbers a finding
        -- was derived from, so the UI can re-render evidence without recomputing.
        CREATE TABLE IF NOT EXISTS health_baselines (
          server_id    TEXT    NOT NULL,
          metric       TEXT    NOT NULL,
          window       TEXT    NOT NULL,
          computed_at  INTEGER NOT NULL,
          sample_count INTEGER NOT NULL,
          value_json   TEXT    NOT NULL,
          PRIMARY KEY (server_id, metric, window)
        );

        -- Finding lifecycle. state: pending -> active -> resolved. A finding
        -- only surfaces once it has persisted across samples; resolving it
        -- starts a cooldown so it cannot immediately re-fire.
        CREATE TABLE IF NOT EXISTS health_alerts (
          id            TEXT    PRIMARY KEY,
          server_id     TEXT    NOT NULL,
          rule_id       TEXT    NOT NULL,
          severity      TEXT    NOT NULL,
          state         TEXT    NOT NULL,
          occurrences   INTEGER NOT NULL DEFAULT 1,
          first_seen_at INTEGER NOT NULL,
          last_seen_at  INTEGER NOT NULL,
          cooldown_until INTEGER,
          algo_version  TEXT    NOT NULL,
          evidence_json TEXT    NOT NULL,
          UNIQUE (server_id, rule_id)
        );
        CREATE INDEX IF NOT EXISTS health_alerts_server_state_idx
          ON health_alerts(server_id, state, last_seen_at DESC);

        -- Last analysis run per server. A failed run leaves the previous
        -- findings in place and marks them stale rather than clearing them.
        CREATE TABLE IF NOT EXISTS health_analysis (
          server_id   TEXT    PRIMARY KEY,
          computed_at INTEGER NOT NULL,
          ok          INTEGER NOT NULL,
          error_code  TEXT,
          payload_json TEXT NOT NULL
        );

        -- Per-server rule settings (health.manage). Absent row = defaults.
        CREATE TABLE IF NOT EXISTS health_settings (
          server_id     TEXT    PRIMARY KEY,
          updated_at    INTEGER NOT NULL,
          updated_by    TEXT,
          settings_json TEXT    NOT NULL
        );
      `);
    },
  },
  {
    version: 9,
    name: 'world-operations',
    up(db) {
      db.exec(`
        -- Discovery cache only. The configured worlds in config.json stay
        -- authoritative: a row here never registers a world by itself, and a
        -- world missing from this table is still a world.
        CREATE TABLE IF NOT EXISTS world_inventory (
          server_id     TEXT    NOT NULL,
          world_id      TEXT    NOT NULL,
          name          TEXT    NOT NULL,
          relative_path TEXT    NOT NULL,
          marker_hash   TEXT,
          size_bytes    INTEGER NOT NULL,
          scanned_at    INTEGER NOT NULL,
          PRIMARY KEY (server_id, world_id)
        );

        -- Domain detail for a durable operation. The operation row owns state,
        -- phase and journal; this only adds what world work needs to describe
        -- itself. Paths here are relative to the server folder - never absolute.
        CREATE TABLE IF NOT EXISTS world_operations (
          operation_id     TEXT    PRIMARY KEY,
          server_id        TEXT    NOT NULL,
          world_id         TEXT,
          action           TEXT    NOT NULL,
          source_json      TEXT,
          destination_json TEXT,
          result_json      TEXT
        );
        CREATE INDEX IF NOT EXISTS world_operations_server_idx
          ON world_operations(server_id);

        -- Previews are the consent record for a destructive request: a mutation
        -- may only run against a preview the same actor took, before it expired,
        -- and only while the server still looks the way the preview described.
        CREATE TABLE IF NOT EXISTS world_previews (
          token       TEXT    PRIMARY KEY,
          server_id   TEXT    NOT NULL,
          actor_id    TEXT    NOT NULL,
          action      TEXT    NOT NULL,
          world_id    TEXT,
          created_at  INTEGER NOT NULL,
          expires_at  INTEGER NOT NULL,
          fingerprint TEXT    NOT NULL,
          payload_json TEXT   NOT NULL
        );
        CREATE INDEX IF NOT EXISTS world_previews_server_idx
          ON world_previews(server_id, created_at DESC);
      `);
    },
  },
  {
    version: 10,
    name: 'server-templates',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS templates (
          id             TEXT    PRIMARY KEY,
          name           TEXT    NOT NULL,
          description    TEXT    NOT NULL DEFAULT '',
          created_by     TEXT,
          created_at     INTEGER NOT NULL,
          latest_version INTEGER NOT NULL DEFAULT 0,
          deleted_at     INTEGER
        );
        CREATE INDEX IF NOT EXISTS templates_active_idx
          ON templates(deleted_at, created_at DESC);

        CREATE TABLE IF NOT EXISTS template_versions (
          id               TEXT    PRIMARY KEY,
          template_id      TEXT    NOT NULL REFERENCES templates(id),
          version          INTEGER NOT NULL,
          archive_path     TEXT    NOT NULL,
          archive_sha256   TEXT    NOT NULL,
          manifest_json    TEXT    NOT NULL,
          created_at       INTEGER NOT NULL,
          source_server_id TEXT,
          UNIQUE(template_id, version)
        );
        CREATE INDEX IF NOT EXISTS template_versions_template_idx
          ON template_versions(template_id, version DESC);

        CREATE TABLE IF NOT EXISTS template_import_previews (
          token        TEXT    PRIMARY KEY,
          actor_id     TEXT    NOT NULL,
          archive_path TEXT    NOT NULL,
          sha256       TEXT    NOT NULL,
          payload_json TEXT    NOT NULL,
          created_at   INTEGER NOT NULL,
          expires_at   INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 12,
    name: 'api-keys',
    up(db) {
      db.exec(`
        -- A key is a principal, not a credential attached to a user: its id is
        -- what goes in capability_grants.user_id, so the existing authorization
        -- layer governs it without a second permission model. Only the SHA-256
        -- of the secret is stored; the plaintext exists once, in the response
        -- that created it.
        CREATE TABLE IF NOT EXISTS api_keys (
          id           TEXT    PRIMARY KEY,
          name         TEXT    NOT NULL,
          role         TEXT    NOT NULL,
          secret_hash  TEXT    NOT NULL,
          created_at   INTEGER NOT NULL,
          created_by   TEXT,
          expires_at   INTEGER,
          last_used_at INTEGER,
          revoked_at   INTEGER,
          revoked_by   TEXT
        );
        CREATE INDEX IF NOT EXISTS api_keys_active_idx
          ON api_keys(revoked_at, created_at DESC);
      `);
    },
  },
  {
    version: 13,
    name: 'drop-backup-drills',
    up(db) {
      db.exec(`DROP TABLE IF EXISTS backup_drills;`);
    },
  },
  {
    version: 14,
    name: 'bug-reports',
    up(db) {
      db.exec(`
        CREATE TABLE bug_reports (
          id             TEXT PRIMARY KEY,            -- UUID
          actor_id       TEXT NOT NULL,
          actor_username TEXT,
          created_at     INTEGER NOT NULL,            -- epoch ms
          game           TEXT,
          view           TEXT,
          route          TEXT,
          title          TEXT NOT NULL,
          description    TEXT NOT NULL,
          repro_steps    TEXT,
          expected       TEXT,
          user_agent     TEXT,
          version        TEXT,                        -- panel version at submit time
          sync_state     TEXT NOT NULL DEFAULT 'pending'
                         CHECK (sync_state IN ('pending','failed','synced')),
          issue_number   INTEGER,
          issue_url      TEXT,
          marker         TEXT,                        -- idempotency marker
          last_error     TEXT,
          attempts       INTEGER NOT NULL DEFAULT 0,
          updated_at     INTEGER NOT NULL
        );
        CREATE INDEX bug_reports_sync_state_idx ON bug_reports(sync_state);
        CREATE INDEX bug_reports_created_at_idx ON bug_reports(created_at);
        CREATE UNIQUE INDEX bug_reports_marker_unique ON bug_reports(marker);
      `);
    },
  },
  {
    version: 15,
    name: 'edge-product-foundation',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS byoc_targets (
          id           TEXT PRIMARY KEY,
          name         TEXT NOT NULL,
          provider     TEXT NOT NULL,
          endpoint     TEXT NOT NULL,
          region       TEXT NOT NULL,
          resource_tier TEXT NOT NULL,
          secret_ref   TEXT NOT NULL,
          status       TEXT NOT NULL,
          created_at   INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL,
          last_seen_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS byoc_targets_status_idx ON byoc_targets(status, created_at);

        CREATE TABLE IF NOT EXISTS pairing_challenges (
          id           TEXT PRIMARY KEY,
          target_id    TEXT NOT NULL,
          actor_id     TEXT,
          token_hash   TEXT NOT NULL,
          agent_id     TEXT NOT NULL,
          created_at   INTEGER NOT NULL,
          expires_at   INTEGER NOT NULL,
          attempts     INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL,
          used_at      INTEGER,
          FOREIGN KEY (target_id) REFERENCES byoc_targets(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS pairing_challenges_expiry_idx ON pairing_challenges(expires_at, used_at);

        CREATE TABLE IF NOT EXISTS byoc_agents (
          id           TEXT PRIMARY KEY,
          target_id    TEXT NOT NULL,
          token_hash   TEXT NOT NULL,
          created_at   INTEGER NOT NULL,
          revoked_at   INTEGER,
          last_seen_at INTEGER,
          FOREIGN KEY (target_id) REFERENCES byoc_targets(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS byoc_agents_target_idx ON byoc_agents(target_id, revoked_at);

        CREATE TABLE IF NOT EXISTS restore_drills (
          id            TEXT PRIMARY KEY,
          backup_id     TEXT NOT NULL,
          target        TEXT NOT NULL,
          status        TEXT NOT NULL CHECK (status IN ('succeeded','failed')),
          started_at    INTEGER,
          completed_at  INTEGER,
          expected_count INTEGER NOT NULL,
          actual_count   INTEGER NOT NULL,
          diff_json     TEXT NOT NULL,
          created_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS restore_drills_created_idx ON restore_drills(created_at DESC, target);

        CREATE TABLE IF NOT EXISTS product_events (
          id          TEXT PRIMARY KEY,
          type        TEXT NOT NULL,
          server_id   TEXT,
          game        TEXT,
          plan        TEXT,
          source      TEXT,
          value       REAL,
          occurred_at INTEGER NOT NULL,
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS product_events_occurred_idx ON product_events(occurred_at, type);
      `);
    },
  },
];

const SNAPSHOT_DIR = path.join(dataDir(), 'snapshots');
const MAX_SNAPSHOTS = 3;

function ensureSnapshotDir() {
  if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
}

/*
 * Copy the live .db file to a timestamped snapshot. Done with the connection
 * open so WAL writes are flushed; better-sqlite3's checkpoint() takes care
 * of merging the WAL back into the main file before we read it.
 */
function takeSnapshot(db) {
  ensureSnapshotDir();
  db.pragma('wal_checkpoint(TRUNCATE)');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(SNAPSHOT_DIR, `fleetdeck-${stamp}.db`);
  fs.copyFileSync(dbPath(), dest);
  pruneSnapshots();
  return dest;
}

function pruneSnapshots() {
  if (!fs.existsSync(SNAPSHOT_DIR)) return;
  const files = fs.readdirSync(SNAPSHOT_DIR)
    .filter((f) => (f.startsWith('fleetdeck-') || f.startsWith('lodestone-')) && f.endsWith('.db'))
    .map((f) => ({ name: f, full: path.join(SNAPSHOT_DIR, f), mtime: fs.statSync(path.join(SNAPSHOT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (let i = MAX_SNAPSHOTS; i < files.length; i++) {
    try { fs.unlinkSync(files[i].full); } catch { /* locked file - keep */ }
  }
}

function listSnapshots() {
  if (!fs.existsSync(SNAPSHOT_DIR)) return [];
  return fs.readdirSync(SNAPSHOT_DIR)
    .filter((f) => (f.startsWith('fleetdeck-') || f.startsWith('lodestone-')) && f.endsWith('.db'))
    .map((f) => path.join(SNAPSHOT_DIR, f))
    .sort();
}

/*
 * Restore the database from a snapshot file. Used by the recovery flow when
 * a migration fails - we copy the most recent pre-migration snapshot back
 * over the live .db file. After this, close() must be called and a fresh
 * open() will see the restored state.
 */
function restoreFromSnapshot(snapshotPath) {
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(`snapshot not found: ${snapshotPath}`);
  }
  close();
  // Wipe the WAL/SHM so a stale write-ahead log doesn't get replayed onto
  // the restored file.
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath() + ext;
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch { /* locked - best effort */ }
    }
  }
  fs.copyFileSync(snapshotPath, dbPath());
}

/*
 * Run all migrations that have not yet been applied. Each migration runs in
 * its own transaction; on failure we restore the prior snapshot and rethrow.
 */
function runMigrations() {
  const db = open();
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
             version    INTEGER PRIMARY KEY,
             name       TEXT    NOT NULL,
             applied_at INTEGER NOT NULL
           );`);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );

  const pending = MIGRATIONS.filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version);
  if (!pending.length) return { applied: [], snapshot: null };

  const snapshot = takeSnapshot(db);
  const log = [];
  for (const m of pending) {
    let tx;
    try {
      tx = db.transaction(() => {
        m.up(db);
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(m.version, m.name, Date.now());
      });
      tx();
      log.push({ version: m.version, name: m.name, status: 'ok' });
    } catch (err) {
      log.push({ version: m.version, name: m.name, status: 'failed', error: err.message });
      try { restoreFromSnapshot(snapshot); } catch (re) {
        err.restoreError = re.message;
      }
      const e = new Error(`migration ${m.version} (${m.name}) failed: ${err.message}`);
      e.migrationError = err;
      e.snapshot = snapshot;
      e.log = log;
      throw e;
    }
  }
  return { applied: log, snapshot };
}

/*
 * Mark a one-shot data import as done. Returns true if this was the first
 * time, false if the import key was already recorded. The caller does the
 * actual import; this just sets the idempotency key.
 */
function recordImport(key, summary) {
  const db = open();
  const result = db.prepare(`
    INSERT INTO data_imports (key, imported_at, summary)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO NOTHING
  `).run(key, Date.now(), JSON.stringify(summary || {}));
  return result.changes === 1;
}

function hasImported(key) {
  const db = open();
  return !!db.prepare('SELECT 1 FROM data_imports WHERE key = ?').get(key);
}

function getImport(key) {
  const db = open();
  return db.prepare('SELECT key, imported_at, summary FROM data_imports WHERE key = ?').get(key) || null;
}

module.exports = {
  runMigrations,
  listSnapshots,
  restoreFromSnapshot,
  recordImport,
  hasImported,
  getImport,
  SNAPSHOT_DIR,
  MAX_SNAPSHOTS,
  MIGRATIONS,
};
