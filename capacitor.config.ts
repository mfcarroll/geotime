// capacitor.config.ts
import { readFileSync } from 'node:fs';
import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The Royal Caribbean app key, read at sync time.
 *
 * Not committed: this repo is public and the key came from Royal Caribbean's own
 * client. It reaches native through the generated `capacitor.config.json`, which
 * `cap sync` writes into each platform and which git does not track — so every
 * build picks the key up on its own (Xcode's Run button, `cap run ios`,
 * gradlew, both CI pipelines) with no wrapper script and no source file being
 * rewritten on the way.
 *
 * Environment first, so CI only has to set a secret. Otherwise `.env.local`,
 * which is gitignored and already holds it for the Vite dev proxy — so there is
 * exactly one place to put it.
 *
 * Empty is a supported state, not an error: only `/v3/ships/{code}/time` needs
 * the key, so a keyless build still searches ships and refreshes the roster. It
 * hides ship features anyway, because no clock could ever be resolved and a ship
 * that cannot tell the time is worse than no ship. See src/rccl.ts.
 */
function rcclAppKey(): string {
  if (process.env.RCCL_APPKEY) return process.env.RCCL_APPKEY;
  try {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const match = line.match(/^\s*(?:export\s+)?RCCL_APPKEY\s*=\s*(.*)$/);
      if (match) return match[1].trim().replace(/^['"]|['"]$/g, '');
    }
  } catch {
    // No .env.local, which is normal in CI where the environment carries it.
  }
  return '';
}

const config: CapacitorConfig = {
  appId: 'ca.matthewcarroll.geotime',
  appName: 'GeoTime',
  webDir: 'dist',
  server: {
    hostname: 'geotime.local',
    androidScheme: 'https',
    iosScheme: 'https',
  },
  plugins: {
    ShipTime: {
      appKey: rcclAppKey(),
    },
  },
};

export default config;
