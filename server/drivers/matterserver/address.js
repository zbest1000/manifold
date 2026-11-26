'use strict';

/**
 * Matter tag addresses: node/endpoint/cluster/attribute.
 *   5/1/1026/0                                   ids, decimal
 *   5/1/0x0402/0x0000                            ids, hexadecimal
 *   5/1/TemperatureMeasurement/MeasuredValue     names, for the clusters in ./clusters.js
 * The normalized form uses decimal ids. The Matter Server keys attributes "endpoint/cluster/attribute".
 */

const { clusterById, clusterByName, attributeDef, attributeByName } = require('./clusters');

const ADDRESS_HELP =
  'node/endpoint/cluster/attribute, e.g. 5/1/1026/0 or 5/1/TemperatureMeasurement/MeasuredValue. ' +
  'Ids may be decimal or hex (0x0402); names work for the built-in clusters, any cluster is readable by number.';

function parseId(text, what, max) {
  const s = String(text).trim();
  let n = NaN;
  if (/^0x[0-9a-f]+$/i.test(s)) n = parseInt(s.slice(2), 16);
  else if (/^\d+$/.test(s)) n = Number(s);
  if (!Number.isSafeInteger(n) || n < 0 || n > max) return null;
  void what;
  return n;
}

/**
 * @returns {{ nodeId:number, endpoint:number, cluster:number, attribute:number, path:string, address:string }}
 * @throws Error with a message for the user
 */
function parseAddress(address) {
  if (typeof address !== 'string' || !address.trim()) throw new Error(`address is required (${ADDRESS_HELP})`);
  const parts = address.trim().split('/');
  if (parts.length !== 4) throw new Error(`"${address}" is not node/endpoint/cluster/attribute`);
  const nodeId = parseId(parts[0], 'node', Number.MAX_SAFE_INTEGER);
  if (nodeId === null || nodeId === 0) throw new Error(`node id "${parts[0]}" must be a positive integer`);
  const endpoint = parseId(parts[1], 'endpoint', 0xfffe);
  if (endpoint === null) throw new Error(`endpoint "${parts[1]}" must be 0-65534`);
  let cluster = parseId(parts[2], 'cluster', 0xffffffff);
  if (cluster === null) {
    const c = clusterByName(parts[2]);
    if (!c) throw new Error(`unknown cluster "${parts[2]}": use its numeric id for clusters outside the built-in list`);
    cluster = c.id;
  }
  let attribute = parseId(parts[3], 'attribute', 0xffffffff);
  if (attribute === null) {
    const a = attributeByName(cluster, parts[3]);
    if (!a) {
      const c = clusterById(cluster);
      throw new Error(`unknown attribute "${parts[3]}"${c ? ` in ${c.name}` : ''}: use its numeric id`);
    }
    attribute = a.id;
  }
  const path = `${endpoint}/${cluster}/${attribute}`;
  return { nodeId, endpoint, cluster, attribute, path, address: `${nodeId}/${path}` };
}

/** Human label of an address: "TemperatureMeasurement.MeasuredValue" or ids. */
function describePath(cluster, attribute) {
  const c = clusterById(cluster);
  const a = attributeDef(cluster, attribute);
  return `${c ? c.name : `Cluster ${cluster}`}.${a ? a.name : `Attribute ${attribute}`}`;
}

module.exports = { parseAddress, describePath, ADDRESS_HELP };
