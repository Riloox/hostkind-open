import minecraftLogo from '@/assets/games/minecraft-logo.webp';
import minecraftIcon from '@/assets/games/minecraft-icon.webp';
import minecraftHero from '@/assets/games/minecraft-hero-v2.jpg';
import terrariaLogo from '@/assets/games/terraria-logo.webp';
import terrariaIcon from '@/assets/games/terraria-icon.webp';
import terrariaHero from '@/assets/games/terraria-hero.jpg';
import valheimLogo from '@/assets/games/valheim-logo.webp';
import valheimIcon from '@/assets/games/valheim-icon.webp';
import valheimHero from '@/assets/games/valheim-hero.jpg';
import palworldLogo from '@/assets/games/palworld-logo.webp';
import palworldIcon from '@/assets/games/palworld-icon.webp';
import palworldHero from '@/assets/games/palworld-hero.jpg';
import customHero from '@/assets/games/custom-hero.jpg';

export const GAMES = [
  { id: 'minecraft', label: 'Minecraft', accent: 'minecraft', logo: minecraftLogo, icon: minecraftIcon, artwork: minecraftHero },
  { id: 'terraria', label: 'Terraria', accent: 'terraria', logo: terrariaLogo, icon: terrariaIcon, artwork: terrariaHero },
  { id: 'valheim', label: 'Valheim', accent: 'valheim', logo: valheimLogo, icon: valheimIcon, artwork: valheimHero },
  { id: 'palworld', label: 'Palworld', accent: 'palworld', logo: palworldLogo, icon: palworldIcon, artwork: palworldHero },
  { id: 'custom', label: 'Other Processes', accent: 'custom', logo: null, artwork: customHero },
];

export const GAME_IDS = new Set(GAMES.map(game => game.id));

export function gameById(id) {
  return GAMES.find(game => game.id === id) || GAMES[GAMES.length - 1];
}

export function gameForServer(server) {
  return GAME_IDS.has(server?.type) ? server.type : 'minecraft';
}
