/**
 * Minimal ambient declarations for diff@7.x.
 * diff@7 ships an exports map with no "types" entry, which breaks NodeNext
 * module resolution. @types/diff exists but cannot be auto-resolved through
 * the exports map. This file provides the subset of types used by the project.
 */
declare module "diff" {
  export interface Change {
    count?: number;
    value: string;
    added?: boolean;
    removed?: boolean;
  }

  export interface LinesOptions {
    ignoreWhitespace?: boolean;
    newlineIsToken?: boolean;
    ignoreNewlineAtEof?: boolean;
    stripTrailingCr?: boolean;
  }

  export function diffLines(
    oldStr: string,
    newStr: string,
    options?: LinesOptions,
  ): Change[];

  export function diffChars(oldStr: string, newStr: string): Change[];
  export function diffWords(oldStr: string, newStr: string): Change[];
  export function createPatch(
    fileName: string,
    oldStr: string,
    newStr: string,
    oldHeader?: string,
    newHeader?: string,
  ): string;
}
