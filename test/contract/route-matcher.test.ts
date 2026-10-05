import { describe, expect, it } from 'vitest';
import { matchRoute } from '../../projects/app/src/shared/api/route-matcher';

describe('route matcher (12.9)', () => {
  it('matches static, templated and catch-all declared routes', () => {
    expect(matchRoute('GET', '/api/core/dataset/list')?.routeId).toBe('API-DS-001');
    expect(matchRoute('GET', '/api/core/dataset/delete-jobs/abc')?.routeId).toBe('API-DEL-001');
    expect(matchRoute('POST', '/proApi/core/dataset/changeOwner')?.routeId).toBe('API-ACL-005');
    expect(matchRoute('GET', '/proApi/core/dataset/collaborator/list')?.routeId).toBe(
      'API-ACL-003',
    );
    expect(matchRoute('GET', '/api/core/dataset/unknown-thing')).toBeNull();
  });

  it('does not match the wrong method', () => {
    expect(matchRoute('GET', '/api/core/dataset/create')).toBeNull();
    expect(matchRoute('POST', '/api/core/dataset/list')).toBeNull();
  });
});
