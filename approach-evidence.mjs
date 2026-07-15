#!/usr/bin/env node

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { readApproachAttempts } from './approach-attempts.mjs';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { loadStates, resolveState, resolveTrackerPath } from './tracker-utils.mjs';

const DEFAULT_MIN_RESOLVED = 8;
const DEFAULT_MIN_PROGRESSIONS = 2;
function normalized(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function assessChannelEvidence(observations, options = {}) {
  const minResolved = options.minResolved ?? DEFAULT_MIN_RESOLVED;
  const minProgressions = options.minProgressions ?? DEFAULT_MIN_PROGRESSIONS;
  const byOpportunity = new Map();
  const byChannel = new Map();

  for (const observation of observations) {
    const channel = normalized(observation.channel);
    const opportunity = Number(observation.opportunity);
    if (!channel || !Number.isInteger(opportunity)) continue;
    if (!byOpportunity.has(opportunity)) byOpportunity.set(opportunity, new Set());
    byOpportunity.get(opportunity).add(channel);
    if (!byChannel.has(channel)) byChannel.set(channel, new Map());
    const current = byChannel.get(channel).get(opportunity) ?? { resolved: false, progressed: false };
    current.resolved ||= observation.resolved === true;
    current.progressed ||= observation.progressed === true;
    byChannel.get(channel).set(opportunity, current);
  }

  const channels = {};
  for (const [channel, opportunities] of [...byChannel.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const values = [...opportunities.values()];
    const resolved = values.filter((item) => item.resolved).length;
    const progressed = values.filter((item) => item.resolved && item.progressed).length;
    channels[channel] = {
      total: values.length,
      resolved,
      progressed,
      progressionRate: resolved > 0 ? progressed / resolved : null,
      passesFloor: resolved >= minResolved && progressed >= minProgressions,
    };
  }

  const confoundedOpportunities = [...byOpportunity.entries()]
    .filter(([, channelSet]) => channelSet.size > 1)
    .map(([opportunity]) => opportunity)
    .sort((a, b) => a - b);
  const channelValues = Object.values(channels);
  const comparable = channelValues.length >= 2 && confoundedOpportunities.length === 0;
  const sufficient = comparable && channelValues.every((channel) => channel.passesFloor);

  return {
    sufficient,
    comparable,
    confounded: confoundedOpportunities.length > 0,
    confoundedOpportunities,
    thresholds: { minResolved, minProgressions },
    channels,
    conclusion: sufficient
      ? 'Personal channel evidence is sufficient to permit a comparison; judgment is still required.'
      : 'Personal channel evidence is insufficient or confounded; use generic priors only as a planning aid.',
  };
}

function trackerStages(path) {
  if (!existsSync(path)) return new Map();
  const content = readFileSync(path, 'utf-8');
  const lines = content.split('\n');
  const columns = resolveColumns(lines);
  const stages = new Map();
  const states = loadStates();
  for (const line of lines) {
    const row = parseTrackerRow(line, columns);
    if (!row) continue;
    stages.set(row.num, resolveState(row.status, states)?.id ?? null);
  }
  return stages;
}

function approachOutcomeSets(states) {
  const approached = states.records.find((record) => record.owner === 'external' && record.onDemand.includes('review_approach'));
  if (!approached) throw new Error('states.yml has no external review_approach stage');
  const reachable = new Set();
  const queue = [...approached.nextStates];
  while (queue.length > 0) {
    const id = queue.shift();
    if (reachable.has(id)) continue;
    reachable.add(id);
    const record = states.byId.get(String(id).toLowerCase());
    if (record) queue.push(...record.nextStates);
  }
  const resolved = new Set(
    [...reachable].filter((id) => states.byId.get(String(id).toLowerCase())?.owner === 'none'),
  );
  const progressed = new Set(
    [...reachable].filter((id) => {
      const record = states.byId.get(String(id).toLowerCase());
      return record && (record.owner !== 'none' || record.group === 'accepted');
    }),
  );
  return { progressed, resolved };
}

export function analyzeApproachEvidence({ appsFile, attemptsFile, ...options }) {
  const stages = trackerStages(appsFile);
  const outcomes = approachOutcomeSets(loadStates());
  const observations = readApproachAttempts(attemptsFile).map((attempt) => {
    const stage = stages.get(attempt.opportunity);
    return {
      opportunity: attempt.opportunity,
      channel: attempt.channel,
      resolved: outcomes.resolved.has(stage),
      progressed: outcomes.progressed.has(stage),
    };
  });
  return assessChannelEvidence(observations, options);
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const root = dirname(fileURLToPath(import.meta.url));
  const result = analyzeApproachEvidence({
    appsFile: resolveTrackerPath(root),
    attemptsFile: join(root, 'data', 'approach-attempts.md'),
  });
  console.log(JSON.stringify(result, null, 2));
}
