interface LivenessResponse {
  status: "alive";
  checked_at: string;
  service: "openwiki";
}

export function liveness(): LivenessResponse {
  return {
    status: "alive",
    checked_at: new Date().toISOString(),
    service: "openwiki",
  };
}
