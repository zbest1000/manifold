'use strict';

const model = require('./bindingModel');

/**
 * "Why is nothing publishing?" - a plain-language diagnosis per mapping for the Mappings table
 * (GET /api/tags/bindings `health`). Read-only, computed from configuration plus the engine's
 * counters; bounded by the number of mappings.
 *
 *   { state: 'publishing' | 'waiting' | 'problem' | 'disabled' | 'source-missing',
 *     reasons: [{ code, message, fix? }] }
 */

function sourceMissing(b, ctx) {
  const s = b.source || {};
  const { profiles, mqttManager, opcuaManager } = ctx;
  if (s.type === 'device' && !profiles.getIn('devices', s.deviceId)) {
    return { code: 'source-missing', message: `The device ${s.deviceId} no longer exists.`, fix: 'Delete this mapping, or recreate the device and point the mapping at it.' };
  }
  if (s.type === 'device-profile' && !profiles.getIn('deviceProfiles', s.profileId)) {
    return { code: 'source-missing', message: `The device profile ${s.profileId} no longer exists.`, fix: 'Delete this mapping, or map another profile.' };
  }
  if (s.type === 'opcua') {
    const known = (profiles.opcuaEndpoints?.() || []).some((c) => c.id === s.connectionId) || (opcuaManager?.getConnections?.() || []).some((c) => c.id === s.connectionId);
    if ((profiles.opcuaEndpoints || opcuaManager) && !known) {
      return { code: 'source-missing', message: `The OPC UA connection ${s.connectionId} was removed.`, fix: 'Reconnect the server under OPC UA (same connection), or delete this mapping.' };
    }
  }
  if ((s.type === 'mqtt' || s.type === 'sparkplug' || s.type === 'iot') && !brokerKnown(s.brokerId, profiles, mqttManager)) {
    return { code: 'source-missing', message: `The source broker ${s.brokerId} was removed.`, fix: 'Add the broker again under Brokers (same id), or delete this mapping.' };
  }
  return null;
}

function brokerKnown(id, profiles, mqttManager) {
  if (!profiles.brokers && !mqttManager?.getConnection) return true;
  return (profiles.brokers?.() || []).some((e) => e.config?.id === id) || Boolean(mqttManager?.getConnection?.(id));
}

function diagnose(b, ctx) {
  const reasons = [];
  if (b.enabled === false) return { state: 'disabled', reasons: [{ code: 'disabled', message: 'Switched off: nothing is monitored or published.', fix: 'Turn the switch on.' }] };
  const st = ctx.status[b.id] || {};
  const missing = sourceMissing(b, ctx);
  if (missing) reasons.push(missing);
  const t = b.target || {};
  if (!brokerKnown(t.brokerId, ctx.profiles, ctx.mqttManager)) {
    reasons.push({ code: 'target-missing', message: `The target broker ${t.brokerId} was removed.`, fix: 'Edit the mapping and choose another broker.' });
  } else if (ctx.mqttManager?.getConnection && ctx.mqttManager.getConnection(t.brokerId)?.status !== 'connected') {
    reasons.push({ code: 'target-offline', message: `The target broker ${t.brokerId} is not connected; nothing can be published until it is.` });
  }
  if (!missing && st.sourceState?.state === 'offline') {
    reasons.push({ code: 'source-offline', message: `The source is offline${st.sourceState.reason ? ` (${st.sourceState.reason})` : ''}.` });
  }
  if (!missing && b.source?.type !== 'sparkplug') {
    const units = model.expandUnits(b, ctx.profiles);
    const tags = units.reduce((n, u) => n + u.tags.length, 0);
    const errs = units.filter((u) => u.error);
    if (errs.length) reasons.push({ code: 'unit-error', message: `${errs.length} asset${errs.length === 1 ? '' : 's'} cannot be resolved: ${errs[0].error}` });
    if (!tags && units.length) {
      const s = b.source || {};
      const allOff = Array.isArray(s.tags) && s.tags.length && s.tags.every((e) => e && typeof e === 'object' && e.enabled === false);
      if (allOff) reasons.push({ code: 'all-disabled', message: 'Every tag of this mapping is switched off.', fix: 'Edit the mapping and switch tags on under Tags.' });
      else if (s.type === 'mqtt' && s.tags === 'all') reasons.push({ code: 'no-topics', message: `No topic on the broker matches ${s.filter}${s.select ? ' and the rules' : ''} yet.` });
      else if (s.type === 'iot' && s.tags === 'all') reasons.push({ code: 'no-topics', message: `IoT device ${s.deviceId} has not been seen on broker ${s.brokerId} yet (is detection enabled for its convention?).` });
      else if (s.tags === 'all') reasons.push({ code: 'no-match', message: '0 tags match the selection rules.', fix: 'Edit the rules under What.' });
      else reasons.push({ code: 'no-tags', message: 'The mapping has no tags.' });
    }
  }
  if (st.loopBlocked) reasons.push({ code: 'loop', message: `Loop guard stopped ${st.loopBlocked} message${st.loopBlocked === 1 ? '' : 's'}: what this mapping reads is fed by its own output through another mapping or a pipeline.` });
  if (st.staleNow) reasons.push({ code: 'stale', message: `${st.staleNow} topic${st.staleNow === 1 ? ' has' : 's have'} sent nothing within the staleness limit (published as Bad, reason stale).` });
  if (st.lastError) reasons.push({ code: 'error', message: `Last error: ${st.lastError}` });
  if (!reasons.length && st.suppressed > 0 && !st.published) {
    reasons.push({ code: 'deadband', message: `Values arrive but do not change beyond the deadband: ${st.suppressed} suppressed, none published yet.`, fix: 'Lower the deadband or add a heartbeat under Delivery.' });
  }
  const blocking = reasons.some((r) => ['source-missing', 'target-missing', 'target-offline', 'source-offline', 'all-disabled', 'no-match', 'no-tags', 'unit-error', 'loop'].includes(r.code));
  let state = 'publishing';
  if (missing) state = 'source-missing';
  else if (blocking || st.lastError) state = 'problem';
  else if (!st.published && st.sourceState?.state !== 'online') state = 'waiting';
  if (state === 'waiting' && !reasons.length) reasons.push({ code: 'waiting', message: 'Waiting for the first value from the source.' });
  return { state, reasons };
}

/** { <bindingId>: diagnosis } for every stored mapping. */
function healthOf(ctx) {
  const out = {};
  for (const b of ctx.profiles.listIn('bindings')) out[b.id] = diagnose(b, ctx);
  return out;
}

module.exports = { diagnose, healthOf, sourceMissing };
