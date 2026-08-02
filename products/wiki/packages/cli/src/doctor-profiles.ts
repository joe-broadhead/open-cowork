import type { DiagnosticRequirement } from "./doctor-diagnostics.ts";

export type DoctorProfile = "personal" | "hosted";

interface DoctorProfileRequirements {
  publicOrigin: DiagnosticRequirement;
  rateLimits: DiagnosticRequirement;
  gitRemote: DiagnosticRequirement;
  postgres: DiagnosticRequirement;
  writeCoordinator: DiagnosticRequirement;
}

export function doctorProfileFor(value: string | undefined): DoctorProfile | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "personal") {
    return "personal";
  }
  if (value === "hosted") {
    return "hosted";
  }
  throw new Error("doctor --profile expected personal or hosted.");
}

export function doctorProfileRequirements(profile: DoctorProfile | undefined): DoctorProfileRequirements {
  if (profile === "hosted") {
    return {
      publicOrigin: "warn",
      rateLimits: "warn",
      gitRemote: "warn",
      postgres: "warn",
      writeCoordinator: "warn",
    };
  }
  return {
    publicOrigin: "skip",
    rateLimits: "skip",
    gitRemote: profile === "personal" ? "warn" : "skip",
    postgres: "skip",
    writeCoordinator: "skip",
  };
}
