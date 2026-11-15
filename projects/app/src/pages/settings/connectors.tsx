import {
  ConnectorsPanel,
  ProductAppShell,
  ProductPage,
  ProductPageHeader,
  ProductSkeleton,
} from '@kb/web';
import Head from 'next/head';
import { useRouter } from 'next/router';

function queryValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

export default function ConnectorsSettingsPage() {
  const router = useRouter();
  const spaceId = queryValue(router.query.spaceId);
  const provider = queryValue(router.query.provider);
  const connectorId = queryValue(router.query.connectorId);

  if (!router.isReady) {
    return (
      <ProductAppShell active="knowledge" title="数据源连接器">
        <ProductPage>
          <ProductSkeleton rows={3} />
        </ProductPage>
      </ProductAppShell>
    );
  }

  return (
    <>
      <Head>
        <title>数据源连接器</title>
      </Head>
      <ProductAppShell active="knowledge" title="数据源连接器">
        <ProductPage>
          <ProductPageHeader
            title="数据源连接器"
            description="配置飞书等外部来源，管理同步状态和凭证。"
          />
          {spaceId ? (
            <ConnectorsPanel
              spaceId={spaceId}
              initialProvider={provider || 'feishu'}
              initialConnectorId={connectorId}
            />
          ) : (
            <div className="kb2-error-panel" role="alert">
              请选择知识库后再配置连接器。
            </div>
          )}
        </ProductPage>
      </ProductAppShell>
    </>
  );
}
