/** The arguments and environment a form with `LaunchFields` holds. */
export function readLaunch(data: FormData) {
  const names = data.getAll('envName').map(String)
  const values = data.getAll('envValue').map(String)
  if (new Set(names).size !== names.length) throw new Error('Environment variable names must be unique.')
  return {
    args: String(data.get('args') ?? ''),
    env: Object.fromEntries(names.map((name, index) => [name, values[index]])),
  }
}
