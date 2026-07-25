import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('topology incrementally updates keyed routes and exposes route tracing', () => {
  const topology = readFileSync(new URL('../src/web/topology.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../src/web/styles/12-topology.css', import.meta.url), 'utf8');

  assert.match(topology, /DP\.x \+ DP\.w,[\s\S]*DL\.x,[\s\S]*download\.cy/);
  assert.doesNotMatch(topology, /topologyEdge\(RR\.x \+ RR\.w, rr\.cy, DL\.x/);
  assert.match(topology, /topologyProfilePill\([\s\S]*downloadNode\.cy[\s\S]*rr\.dpName/);
  assert.doesNotMatch(topology, /dpMap|Used by .*RR profile/);
  assert.match(topology, /data-topology-related/);
  assert.match(topology, /data-topology-id/);
  assert.match(topology, /syncTopologyElement\(current, desired, true\)/);
  assert.match(topology, /child\.nodeValue = desiredChild\.nodeValue/);
  assert.match(topology, /if \(!desiredIds\.has\(id\)\) element\.remove\(\)/);
  assert.match(topology, /focused\.focus\(\{ preventScroll: true \}\)/);
  assert.doesNotMatch(topology, /canvas\.innerHTML = `<svg/);
  assert.match(topology, /canvas\.onpointerover/);
  assert.match(topology, /canvas\.onfocusin/);
  assert.match(topology, /canvas\.dataset\.topologyTraceKey = key/);
  assert.match(styles, /\.topo-svg\.is-tracing/);
});

// The map's own description promises it shows how downloads connect, so a
// download that connects to nothing is exactly the one it must not drop. An
// ownerless download matches no profile band and would otherwise be invisible
// in the one view a user opens to work out why a download is stuck.
test('the topology surfaces downloads that belong to no RR profile', () => {
  const topology = readFileSync(new URL('../src/web/topology.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../src/web/styles/12-topology.css', import.meta.url), 'utf8');

  assert.match(topology, /export function topologyOwnerlessDownloads\(\)/);
  assert.match(topology, /\.filter\(\(download\) => download\.profileId == null\)/);
  // Rendered, not merely computed.
  assert.match(topology, /renderTopologyOrphanNotice\(canvas, topologyOwnerlessDownloads\(\)\)/);
  assert.match(topology, /no owning RR profile and connect to nothing/);
  // Named so the user can act on it, and removed again once there are none.
  assert.match(topology, /orphans\.map\(\(download\) => download\.name\)/);
  assert.match(topology, /if \(orphans\.length === 0\) \{\s*if \(notice\) notice\.remove\(\);/);
  assert.match(styles, /\.topo-orphans \{/);
});
