'use strict';

/*
 * Module capability gating.
 *
 * `server.js` refuses a route with 404 `not_supported` when the targeted
 * server's module does not implement that feature - "Minecraft has plugins,
 * Palworld has a REST API" and so on. That decision used to read the module's
 * static `capabilities` list, which is keyed by game type.
 *
 * That is not enough for Terraria: one game type, three variants, and only
 * tModLoader has mods while only TShock has the TShock admin surface
 * (docs/terraria/00-baseline-contracts.md "Declare module capabilities"). So
 * the gate asks the module for the capabilities of the *descriptor* when it
 * offers `capabilitiesFor(desc)`, and falls back to the static list otherwise.
 *
 * It lives here rather than inline in server.js so the middleware a test
 * exercises is the middleware the panel runs.
 */

function createModuleGate({ registry, findServer, requestServerId, defaultType = 'minecraft' }) {
  // Only the legacy absence of a descriptor means Minecraft, matching
  // registry.get(): an unknown type resolves to the `unsupported` module, whose
  // capability list is empty.
  function capabilitiesFor(desc) {
    const module = registry.get(desc ? desc.type : defaultType) || { capabilities: [] };
    if (typeof module.capabilitiesFor === 'function') {
      // A module that cannot classify its own descriptor gets the static list,
      // which is the variant-independent subset - never a wider one.
      try { return module.capabilitiesFor(desc) || []; } catch { /* fall through */ }
    }
    return module.capabilities || [];
  }

  function capabilitiesForRequest(req) {
    return capabilitiesFor(findServer(requestServerId(req)));
  }

  function supports(req, capability) {
    return capabilitiesForRequest(req).includes(capability);
  }

  function requireModuleCapability(capability) {
    return (req, res, next) => {
      if (!supports(req, capability)) return res.status(404).json({ error: 'not_supported' });
      next();
    };
  }

  /*
   * Game-type guard for a game-specific route prefix.
   *
   * Capabilities alone are not enough for one: `console` is a capability every
   * game has, so gating /api/terraria on it would let a Minecraft server reach
   * handlers that read a Terraria descriptor. The prefix and the descriptor
   * have to agree before any Terraria-shaped code runs.
   */
  function requireGameType(type) {
    return (req, res, next) => {
      const server = findServer(requestServerId(req));
      if (!server || server.type !== type) return res.status(404).json({ error: 'not_supported' });
      next();
    };
  }

  return { capabilitiesFor, capabilitiesForRequest, supports, requireModuleCapability, requireGameType };
}

module.exports = { createModuleGate };
