import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

test('topology routes downloads through their download profile and exposes route tracing', () => {
  const topology = readFileSync(new URL('../src/web/topology.js', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../src/web/styles/12-topology.css', import.meta.url), 'utf8');

  assert.match(topology, /DP\.x \+ DP\.w,[\s\S]*DL\.x,[\s\S]*download\.cy/);
  assert.doesNotMatch(topology, /topologyEdge\(RR\.x \+ RR\.w, rr\.cy, DL\.x/);
  assert.match(topology, /topologyProfilePill\([\s\S]*downloadNode\.cy[\s\S]*rr\.dpName/);
  assert.doesNotMatch(topology, /dpMap|Used by .*RR profile/);
  assert.match(topology, /data-topology-related/);
  assert.match(topology, /canvas\.onpointerover/);
  assert.match(topology, /canvas\.onfocusin/);
  assert.match(styles, /\.topo-svg\.is-tracing/);
});
