export interface Config {
  steamCountry: string;
  steamLanguage: string;
  postToX: boolean;
  x?: {
    appKey: string;
    appSecret: string;
    accessToken: string;
    accessSecret: string;
  };
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function loadConfig(): Config {
  const postToX = optional("POST_TO_X")?.toLowerCase() === "true";
  const credentials = {
    appKey: optional("X_APP_KEY"),
    appSecret: optional("X_APP_SECRET"),
    accessToken: optional("X_ACCESS_TOKEN"),
    accessSecret: optional("X_ACCESS_SECRET"),
  };

  if (postToX && Object.values(credentials).some((value) => !value)) {
    throw new Error(
      "POST_TO_X=true requires X_APP_KEY, X_APP_SECRET, X_ACCESS_TOKEN, and X_ACCESS_SECRET",
    );
  }

  const config: Config = {
    steamCountry: optional("STEAM_COUNTRY") ?? "JP",
    steamLanguage: optional("STEAM_LANGUAGE") ?? "japanese",
    postToX,
  };

  if (postToX) {
    config.x = {
      appKey: credentials.appKey!,
      appSecret: credentials.appSecret!,
      accessToken: credentials.accessToken!,
      accessSecret: credentials.accessSecret!,
    };
  }

  return config;
}
