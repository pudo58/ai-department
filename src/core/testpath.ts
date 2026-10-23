/** Folder names and Node-style file names that mark a test (case-insensitive). */
const COMMON = /(^|\/)(tests?|__tests__|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
/** JVM, Python and Go conventions. Case-sensitive on purpose: `Digit.java` ends in "it" but is not an integration test. */
const CONVENTIONS = /(^|\/)[^/]*(Tests?|IT|Spec)\.(java|kt|kts|groovy|scala)$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|(^|\/)src\/test\//;

/** Whether a repository-relative posix path is a test file by the conventions of the stacks the system knows. */
export const isTestPath = (p: string): boolean => COMMON.test(p) || CONVENTIONS.test(p);
