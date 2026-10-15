// Sağlayıcı kaydı: arayüz sağlayıcıları kimlikle bulur, hiçbir sürücüyü doğrudan içe aktarmaz.
import type { IDataSourceProvider, ProviderId } from './provider';

const providers = new Map<ProviderId, IDataSourceProvider>();

export function registerProvider(p: IDataSourceProvider): void {
  providers.set(p.id, p);
}

export function getProvider(id: ProviderId): IDataSourceProvider {
  const p = providers.get(id);
  if (!p) throw new Error(`Bilinmeyen sağlayıcı: ${id}`);
  return p;
}

export const listProviders = (): IDataSourceProvider[] => [...providers.values()];
