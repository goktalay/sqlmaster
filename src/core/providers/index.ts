// Yerleşik sağlayıcıları kaydeder. Yeni sağlayıcı = yeni dosya + buraya bir satır.
import { registerProvider } from '../registry';
import { postgresProvider } from './postgres';

let done = false;
export function registerBuiltinProviders(): void {
  if (done) return;
  done = true;
  registerProvider(postgresProvider);
}
