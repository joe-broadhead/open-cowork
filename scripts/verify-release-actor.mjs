function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function validateReleaseActor(input) {
  const actor = String(input?.actor || '').trim()
  const repositoryOwner = String(input?.repositoryOwner || '').trim()
  const allowedActors = splitCsv(input?.allowedActors).length > 0
    ? splitCsv(input.allowedActors)
    : repositoryOwner
      ? [repositoryOwner]
      : []

  if (!actor) throw new Error('GITHUB_ACTOR is required for release actor verification.')
  if (allowedActors.length === 0) {
    throw new Error('No release actors are allowed. Set OPEN_COWORK_RELEASE_ALLOWED_ACTORS or GITHUB_REPOSITORY_OWNER.')
  }
  if (!allowedActors.includes(actor)) {
    throw new Error(`Release actor ${actor} is not allowed to publish releases. Allowed actors: ${allowedActors.join(', ')}.`)
  }
  return { actor, allowedActors }
}

async function main() {
  const result = validateReleaseActor({
    actor: process.env.GITHUB_ACTOR,
    repositoryOwner: process.env.GITHUB_REPOSITORY_OWNER,
    allowedActors: process.env.OPEN_COWORK_RELEASE_ALLOWED_ACTORS,
  })
  process.stdout.write(`Verified release actor ${result.actor}.\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
