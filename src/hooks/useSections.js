import { useCallback, useMemo } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useServer } from '@/context/ServerContext';

const NONE = [];

/**
 * The context src/lib/sections.js checks against, for any one server: what
 * its module supports and what this user may do on it. A grant counts whether
 * it names this server or the whole panel, so the sidebar, the section tabs
 * and the shell's URL guards all agree on what is shown.
 *
 * A server's own capabilities win over its game type's (Terraria's variants
 * differ), the same rule ServerContext applies to the open server.
 */
export function useSectionContextFor(server) {
  const { hasCapability } = useAuth();
  const { modules } = useServer();
  const serverId = server?.id || null;
  const capabilities = server?.capabilities
    || modules.find((module) => module.type === server?.type)?.capabilities
    || NONE;
  const supports = useCallback((capability) => capabilities.includes(capability), [capabilities]);
  const can = useCallback(
    (capability) => hasCapability(capability, serverId) || hasCapability(capability),
    [hasCapability, serverId],
  );
  return useMemo(() => ({ supports, can }), [supports, can]);
}

/** The same context for the open server. */
export function useSectionContext() {
  const { activeServer } = useServer();
  return useSectionContextFor(activeServer);
}
