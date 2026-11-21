/** One POSIX shell word for any string. */
export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
export const shellJoin = (words: string[]) => words.map(quote).join(' ')

export const supportingPath =
  'export PATH="$PATH:$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin"'
