export interface Config {
  steamCountry: string;
  steamLanguage: string;
  postToX: boolean;
  buffer?: {
    apiKey: string;
    channelId: string;
  };
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function loadConfig(): Config {
  const postToX = optional("POST_TO_X")?.toLowerCase() === "true";
  const credentials = {
    apiKey: optional("BUFFER_API_KEY"),
    channelId: optional("BUFFER_CHANNEL_ID"),
  };

  if (postToX && Object.values(credentials).some((value) => !value)) {
    throw new Error(
      "POST_TO_X=true requires BUFFER_API_KEY and BUFFER_CHANNEL_ID",
    );
  }

  const config: Config = {
    steamCountry: optional("STEAM_COUNTRY") ?? "JP",
    steamLanguage: optional("STEAM_LANGUAGE") ?? "japanese",
    postToX,
  };

  if (postToX) {
    config.buffer = {
      apiKey: credentials.apiKey!,
      channelId: credentials.channelId!,
    };
  }

  return config;
}
