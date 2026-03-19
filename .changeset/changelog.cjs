function formatSummary(summary) {
  return summary
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

async function getReleaseLine(changeset, _type, _options) {
  const summary = formatSummary(changeset.summary);
  if (!summary) {
    return "";
  }

  return `- ${summary}`;
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
