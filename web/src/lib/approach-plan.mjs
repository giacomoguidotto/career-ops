function clean(value) {
  return String(value ?? "").trim();
}

function slug(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function sections(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const out = [];
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      if (current) out.push(current);
      current = { title: clean(heading[1]), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) out.push(current);
  return out;
}

function metadata(lines) {
  const fields = {};
  for (const line of lines) {
    const match = line.match(/^\s*-\s*\*\*(.+?):\*\*\s*(.*?)\s*$/);
    if (match) fields[clean(match[1]).toLowerCase()] = clean(match[2]);
  }
  return fields;
}

function routeType(value) {
  const text = clean(value).toLowerCase();
  if (/follow[ -]?up/.test(text)) return "followup";
  if (/qualif|gating|gate question|before applying/.test(text)) return "qualifying";
  if (/formal|application|ats|apply/.test(text)) return "application";
  return "outreach";
}

function materialType(title) {
  const text = clean(title).toLowerCase();
  if (/follow[ -]?up/.test(text)) return "followup";
  if (/gating|qualif/.test(text)) return "qualifying";
  if (/fill the application|application form/.test(text)) return "application";
  if (/outreach|message/.test(text)) return "outreach";
  return null;
}

function parseLimit(value) {
  const text = clean(value);
  const counter = text.match(/(?:^|\D)(\d+)\s*\/\s*(\d+)\s*(?:char|character)/i);
  if (counter) return Number(counter[2]);
  const declared = text.match(/(?:max(?:imum)?\s*|limit(?:ed)?\s*(?:to|:)\s*|(?:under|within|up to|≤|<=)\s*)(\d+)\s*(?:char|character)/i)
    ?? text.match(/(\d+)\s*[- ]character\s+(?:max(?:imum)?|limit)/i);
  return declared ? Number(declared[1]) : null;
}

function regenerationCandidates(notes, current) {
  const match = clean(notes).match(/(?:regeneration|alternative)(?:\s+answers?)?\s*:\s*(.+)$/i);
  if (!match) return [];
  return match[1]
    .split(/\s*\|\|\s*/)
    .map(clean)
    .filter((value) => value && value !== current);
}

function messageBody(lines) {
  const kept = [];
  let afterMetadata = false;
  for (const line of lines) {
    if (/^\s*-\s*\*\*.+?:\*\*/.test(line)) {
      afterMetadata = true;
      continue;
    }
    if (!afterMetadata || /^\s*$/.test(line) && kept.length === 0) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

function tableAnswers(lines) {
  const table = lines.filter((line) => /^\s*\|.*\|\s*$/.test(line));
  if (table.length < 3) return [];
  const split = (line) => {
    const text = line.trim().replace(/^\||\|$/g, "");
    const cells = [];
    let cell = "";
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "\\" && text[index + 1] === "|") {
        cell += "|";
        index += 1;
      } else if (text[index] === "|") {
        cells.push(clean(cell));
        cell = "";
      } else {
        cell += text[index];
      }
    }
    cells.push(clean(cell));
    return cells;
  };
  const headers = split(table[0]).map((header) => header.toLowerCase());
  const questionIndex = headers.indexOf("question");
  const answerIndex = headers.indexOf("answer");
  const notesIndex = headers.indexOf("notes");
  if (questionIndex < 0 || answerIndex < 0) return [];
  return table.slice(2).map((line, index) => {
    const columns = split(line);
    const label = columns[questionIndex] ?? `Question ${index + 1}`;
    const value = columns[answerIndex] ?? "";
    const notes = notesIndex >= 0 ? columns[notesIndex] ?? "" : "";
    const blocked = !value || /^(?:-|—|tbd|unknown|missing)$/i.test(value)
      || /\b(?:blocker|missing personal fact|user must provide|unsupported fact)\b/i.test(notes);
    const instruction = notes.match(/(?:explicit\s+)?jd\s+instruction\s*:\s*(.+?)(?=\s+(?:regeneration|alternative)(?:\s+answers?)?\s*:|$)/i)?.[1]?.trim() ?? null;
    return {
      id: `${index + 1}-${slug(label) || "answer"}`,
      label,
      value: blocked ? "" : value,
      notes,
      instruction,
      limit: parseLimit(`${instruction ?? ""} ${notes}`),
      regenerationCandidates: regenerationCandidates(notes, value),
      state: blocked ? "blocked" : "generated",
    };
  });
}

function missingDestination(value) {
  const text = clean(value);
  return !text || /\b(?:missing|unknown|not found|unverified|tbd|find a contact)\b/i.test(text);
}

function destinationToken(value) {
  const text = clean(value);
  const url = text.match(/(?:https?:\/\/|mailto:)[^\s|)]+/i)?.[0]?.replace(/[.,;:]+$/, "");
  return clean(url || text).toLowerCase();
}

function materialDestination(material) {
  if (clean(material.fields.to)) return clean(material.fields.to);
  return material.section.lines.find((line) => /(?:https?:\/\/|mailto:)/i.test(line)) ?? "";
}

/** Parse only declared Approach Plan content. No route, destination, limit, or answer is inferred. */
export function parseApproachPlan(markdown) {
  const allSections = sections(markdown);
  const ranked = allSections.filter((section) => /^\d+\.\s+/.test(section.title));
  const materials = allSections
    .map((section, index) => ({ section, index, type: materialType(section.title), fields: metadata(section.lines) }))
    .filter((material) => material.type && !/^\d+\.\s+/.test(material.section.title));
  const usedMaterials = new Set();

  function matchingMaterial(type, fields) {
    const candidates = materials.filter((material) => material.type === type && !usedMaterials.has(material.index));
    if (candidates.length === 0) return null;
    const rankedCandidates = candidates.map((material) => {
      let score = 0;
      const rankedDestination = destinationToken(fields.to);
      const candidateDestination = destinationToken(materialDestination(material));
      const destinationMatches = rankedDestination && rankedDestination === candidateDestination;
      if (destinationMatches) score += 4;
      if (clean(fields.channel) && clean(fields.channel) === clean(material.fields.channel)) score += 2;
      return { material, score, destinationMatches };
    }).sort((left, right) => right.score - left.score || left.material.index - right.material.index);
    if (!rankedCandidates[0].destinationMatches) return null;
    const selected = rankedCandidates[0].material;
    usedMaterials.add(selected.index);
    return selected;
  }

  return ranked.map((section, index) => {
    const rankMatch = section.title.match(/^(\d+)\.\s+(?:Best:\s*)?(.+)$/i);
    const fields = metadata(section.lines);
    const type = routeType(`${fields.route ?? ""} ${rankMatch?.[2] ?? section.title} ${fields.channel ?? ""}`);
    const material = matchingMaterial(type, fields);
    const materialFields = material?.fields ?? {};
    const destination = clean(materialFields.to || fields.to);
    const channel = clean(materialFields.channel || fields.channel);
    const connectionNote = clean(materialFields["connection note"]);
    const body = material ? messageBody(material.section.lines) : "";
    const answers = type === "application" && material ? tableAnswers(material.section.lines) : [];
    return {
      id: `${rankMatch?.[1] ?? index + 1}-${type}`,
      rank: Number(rankMatch?.[1] ?? index + 1),
      type,
      label: clean(rankMatch?.[2] ?? section.title),
      destination,
      channel,
      timing: clean(materialFields.when || fields.timing),
      whyFirst: clean(fields["why first"]),
      instruction: clean(materialFields.instruction),
      body,
      limit: parseLimit(connectionNote),
      follows: clean(materialFields.follows || fields.follows) || null,
      answers,
      blockedReason: missingDestination(destination)
        ? "A verified destination is missing from the canonical Approach Plan."
        : !channel
          ? "The canonical Approach Plan does not declare a channel."
          : type === "application" && answers.length === 0
            ? "The canonical Approach Plan does not contain application answers."
            : type !== "application" && !body
              ? "The canonical Approach Plan does not contain sendable text for this route."
            : null,
    };
  }).sort((left, right) => left.rank - right.rank);
}
