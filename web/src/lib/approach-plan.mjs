const ROUTE_TYPES = ["outreach", "application", "qualifying", "followup"];

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
  const match = clean(value).match(/(?:^|\D)(\d+)\s*\/\s*(\d+)\s*(?:char|character)/i);
  return match ? Number(match[2]) : null;
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
  const split = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map(clean);
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
    const instruction = notes.match(/(?:explicit\s+)?jd\s+instruction\s*:\s*(.+)$/i)?.[1]?.trim() ?? null;
    return {
      id: `${index + 1}-${slug(label) || "answer"}`,
      label,
      value: blocked ? "" : value,
      notes,
      instruction,
      state: blocked ? "blocked" : "generated",
    };
  });
}

function missingDestination(value) {
  const text = clean(value);
  return !text || /\b(?:missing|unknown|not found|unverified|tbd|find a contact)\b/i.test(text);
}

/** Parse only declared Approach Plan content. No route, destination, limit, or answer is inferred. */
export function parseApproachPlan(markdown) {
  const allSections = sections(markdown);
  const ranked = allSections.filter((section) => /^\d+\.\s+/.test(section.title));
  const materials = new Map();
  for (const section of allSections) {
    const type = materialType(section.title);
    if (type && !materials.has(type)) materials.set(type, section);
  }

  return ranked.map((section, index) => {
    const rankMatch = section.title.match(/^(\d+)\.\s+(?:Best:\s*)?(.+)$/i);
    const fields = metadata(section.lines);
    const type = routeType(`${fields.route ?? ""} ${rankMatch?.[2] ?? section.title} ${fields.channel ?? ""}`);
    const material = materials.get(type);
    const materialFields = material ? metadata(material.lines) : {};
    const destination = clean(materialFields.to || fields.to);
    const channel = clean(materialFields.channel || fields.channel);
    const connectionNote = clean(materialFields["connection note"]);
    const body = material ? messageBody(material.lines) : "";
    const answers = type === "application" && material ? tableAnswers(material.lines) : [];
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
            : null,
    };
  }).sort((left, right) => left.rank - right.rank);
}

export { ROUTE_TYPES };
