/** One POSIX shell word for any string. */
export const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
export const shellJoin = (words: string[]) => words.map(quote).join(' ')
