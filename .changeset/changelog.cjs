function formatSummary(summary) {
  return summary
    .trim()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

async function getReleaseLine(changeset, _type, _options) {
  const summary = formatSummary(changeset.summary);
  if (!summary) {
    return "";
  }

  const lines = summary.split("\n");
  const [first, ...rest] = lines;
  if (rest.length === 0) {
    return `- ${first.trim()}`;
  }

  return [`- ${first.trim()}`, ...rest.map((line) => (line ? `  ${line}` : ""))].join("\n");
}

async function getDependencyReleaseLine(_changesets, dependenciesUpdated, _options) {
  if (!dependenciesUpdated || dependenciesUpdated.length === 0) {
    return "";
  }

  const names = dependenciesUpdated.map((dependency) => `\`${dependency.name}\``).join(", ");
  return `- Updated internal dependency ranges for ${names}.`;
}

module.exports = {
  getReleaseLine,
  getDependencyReleaseLine,
};
