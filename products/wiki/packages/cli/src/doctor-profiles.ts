import type { DeploymentProfileRequirement } from "./deployment-profiles.ts";

export type DoctorProfile = "personal" | "hosted" | "kubernetes";

interface DoctorProfileRequirements {
  publicOrigin: DeploymentProfileRequirement;
  rateLimits: DeploymentProfileRequirement;
  imageDigest: DeploymentProfileRequirement;
  gitRemote: DeploymentProfileRequirement;
  postgres: DeploymentProfileRequirement;
  writeCoordinator: DeploymentProfileRequirement;
}

export function doctorProfileFor(value: string | undefined): DoctorProfile | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "personal" || value === "local-personal") {
    return "personal";
  }
  if (value === "hosted" || value === "compose" || value === "docker-private") {
    return "hosted";
  }
  if (value === "kubernetes" || value === "k8s" || value === "kubernetes-enterprise") {
    return "kubernetes";
  }
  throw new Error("doctor --profile expected personal, hosted, or kubernetes.");
}

export function doctorProfileRequirements(profile: DoctorProfile | undefined): DoctorProfileRequirements {
  if (profile === "kubernetes") {
    return {
      publicOrigin: "required",
      rateLimits: "required",
      imageDigest: "required",
      gitRemote: "required",
      postgres: "required",
      writeCoordinator: "required",
    };
  }
  if (profile === "hosted") {
    return {
      publicOrigin: "warn",
      rateLimits: "warn",
      imageDigest: "warn",
      gitRemote: "warn",
      postgres: "warn",
      writeCoordinator: "warn",
    };
  }
  return {
    publicOrigin: "skip",
    rateLimits: "skip",
    imageDigest: "skip",
    gitRemote: profile === "personal" ? "warn" : "skip",
    postgres: "skip",
    writeCoordinator: "skip",
  };
}
