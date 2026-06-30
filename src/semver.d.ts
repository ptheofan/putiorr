declare module 'semver' {
  export interface SemVer {
    major: number;
    minor: number;
    patch: number;
    prerelease: Array<string | number>;
    version: string;
  }

  interface SemverModule {
    clean(value: string): string | null;
    compare(left: string, right: string): number;
    gt(left: string, right: string): boolean;
    lt(left: string, right: string): boolean;
    parse(value: string): SemVer | null;
    prerelease(value: string): Array<string | number> | null;
    valid(value: string): string | null;
  }

  const semver: SemverModule;
  export default semver;
}
