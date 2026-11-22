export function prefixedRedisKey(prefix: string, key: string): string {
  const normalizedPrefix = prefix.trim().replace(/:+$/, '');
  return normalizedPrefix ? `${normalizedPrefix}:${key}` : key;
}

export function bullMqPrefix(redisPrefix: string): string {
  return prefixedRedisKey(redisPrefix, 'bull');
}
