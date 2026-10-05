import { ErrorBanner, translate } from '@kb/web';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

describe('front-end error rendering (12.3 / 18.6)', () => {
  it('renders localized text from messageKey and params', () => {
    const html = renderToString(
      createElement(ErrorBanner, {
        error: {
          messageKey: 'error.dataset.resource_not_found',
          params: { resourceType: 'dataset' },
        },
      }),
    );
    expect(html).toContain('资源不存在或不可见');
  });

  it('interpolates params without using the backend compatibility message', () => {
    expect(translate('error.dataset.extension.disabled', {}, 'en')).toBe(
      'Extension is not enabled',
    );
    const html = renderToString(
      createElement(ErrorBanner, {
        error: { messageKey: 'error.custom.param', params: { name: 'demo' } },
      }),
    );
    // 未登记 key 时退化为 key 本身，绝不渲染服务端 message 文本。
    expect(html).toContain('error.custom.param');
  });
});
