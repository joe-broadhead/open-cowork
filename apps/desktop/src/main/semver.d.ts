declare module 'semver' {
  const semver: {
    clean(version: string): string | null
    coerce(version: string): { version: string } | null
    compare(left: string, right: string): number
  }

  export default semver
}
