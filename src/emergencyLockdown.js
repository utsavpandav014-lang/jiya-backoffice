export function normalizeEmergencyStatus(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return {
    enabled: raw?.enabled === true,
    enabledAt: raw?.enabledAt || null,
    updatedAt: raw?.updatedAt || null,
  };
}

export function mustBlockForEmergency(status, auth) {
  return Boolean(status?.enabled && auth?.role !== "superadmin");
}

