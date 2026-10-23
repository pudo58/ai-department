import path from 'node:path';

/** What the project's commands need on the machine, decided from the commands themselves (no new setting to maintain). */
export interface EnvNeeds {
  python: boolean;
  /** Any JVM build tool is used, so a JDK must exist. */
  java: boolean;
  /** A bare `mvn` / `gradle` (not the project's own wrapper) is used. */
  maven: boolean;
  gradle: boolean;
  /** Java major version the project asks for, when its build files say so. */
  jdkRequired?: number;
}

/** Long-term-support JDK lines that Temurin publishes. A project asking for 9 or 19 gets the next one up. */
export const JDK_LTS = [8, 11, 17, 21, 25] as const;

/** The JDK to install for a project: the lowest LTS that satisfies it, or the common modern default when unknown. */
export const jdkToInstall = (required?: number): number => JDK_LTS.find((v) => v >= (required ?? 21)) ?? JDK_LTS[JDK_LTS.length - 1]!;

const base = (token: string): string => path.win32.basename(token).toLowerCase().replace(/\.(cmd|bat|exe)$/, '');

/** "1.8" and "8" both mean Java 8. Anything that is not a plain version is unknown. */
export function javaMajor(version: string | undefined): number | undefined {
  const m = /^\s*(?:1\.)?(\d{1,2})(?:[._]|\s*$)/.exec(version ?? '');
  const major = m ? Number(m[1]) : undefined;
  return major !== undefined && major >= 6 && major <= 40 ? major : undefined;
}

/** The Java version a Maven or Gradle build file asks for, if it says. */
export function javaVersionOf(buildFileText: string): number | undefined {
  const m = /<(?:maven\.compiler\.release|maven\.compiler\.source|java\.version|release)>\s*([\d.]+)\s*</.exec(buildFileText)
    ?? /JavaLanguageVersion\.of\(\s*(\d+)\s*\)/.exec(buildFileText)
    ?? /(?:sourceCompatibility|jvmTarget|targetCompatibility)\s*=?\s*(?:JavaVersion\.VERSION_)?['"]?([\d._]+)/.exec(buildFileText);
  return javaMajor(m?.[1]?.replace(/_/g, '.'));
}

/**
 * `commands` are every command the project runs (setup and checks). The first two tokens are inspected so that both
 * `mvn -B test` and `sh ./mvnw test` are recognised.
 */
export function planEnvironment(commands: readonly (readonly string[])[], javaVersion?: number): EnvNeeds {
  const uses = (...names: string[]) => commands.some((c) => c.slice(0, 2).some((token) => names.includes(base(token))));
  const maven = uses('mvn'), gradle = uses('gradle');
  return {
    python: uses('python', 'python3', 'py', 'pytest', 'pip'),
    java: maven || gradle || uses('mvnw', 'gradlew'),
    maven, gradle,
    ...(javaVersion ? { jdkRequired: javaVersion } : {}),
  };
}
