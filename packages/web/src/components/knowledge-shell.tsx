'use client';

import { Box, Flex, Link, Text } from '@chakra-ui/react';
import { useEffect, useState, type ReactNode } from 'react';
import { ensureConsoleSession, type ConsoleSession } from '../client/knowledge-client';
import { useKnowledgeI18n, type MessageKey } from '../i18n';
import { Button } from './knowledge-primitives';

export interface ShellLocation {
  pathname: string;
  query: Record<string, string | string[] | undefined>;
}

function queryString(
  query: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = query[key];
  return Array.isArray(value) ? value[0] : value;
}

function navLink(active: boolean) {
  return {
    minHeight: '36px',
    display: 'grid',
    gridTemplateColumns: { base: '1fr', lg: '34px 1fr' },
    alignItems: 'center',
    px: 2,
    py: '7px',
    color: active ? 'kn.primary' : 'kn.ink',
    bg: active ? 'kn.surface' : 'transparent',
    borderLeftWidth: '2px',
    borderLeftColor: active ? 'kn.primary' : 'transparent',
    fontWeight: active ? '700' : '400',
    textDecoration: 'none',
    _hover: { bg: 'kn.surface', textDecoration: 'none' },
  } as const;
}

export function KnowledgeAppShell(props: { location: ShellLocation; children: ReactNode }) {
  const { locale, setLocale, t } = useKnowledgeI18n();
  const [session, setSession] = useState<ConsoleSession | null>(null);
  const [sessionError, setSessionError] = useState(false);
  const spaceId = queryString(props.location.query, 'spaceId');

  useEffect(() => {
    let active = true;
    void ensureConsoleSession()
      .then((value) => {
        if (active) setSession(value);
      })
      .catch(() => {
        if (active) setSessionError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const spaceLinks: ReadonlyArray<readonly [string, MessageKey, string]> = spaceId
    ? [
        ['01', 'nav.overview', `/spaces/${spaceId}/overview`],
        ['02', 'nav.sources', `/spaces/${spaceId}/sources`],
        ['03', 'nav.import', `/spaces/${spaceId}/import`],
        ['04', 'nav.segments', `/spaces/${spaceId}/segments`],
        ['05', 'nav.tags', `/spaces/${spaceId}/tags`],
        ['06', 'nav.access', `/spaces/${spaceId}/access`],
        ['07', 'nav.jobs', `/spaces/${spaceId}/jobs`],
        ['08', 'nav.search', `/spaces/${spaceId}/search`],
        ['09', 'nav.images', `/spaces/${spaceId}/images`],
      ]
    : [];

  return (
    <Box
      className="console-shell"
      minH="100vh"
      display={{ base: 'block', lg: 'grid' }}
      gridTemplateColumns={{ lg: '240px minmax(0, 1fr)' }}
    >
      <Box
        as="a"
        className="skip-link"
        href="#knowledge-main"
        position="fixed"
        top="8px"
        left="8px"
        zIndex="docked"
        px={3}
        py={2}
        bg="kn.ink"
        color="kn.surface"
        transform="translateY(-160%)"
        borderRadius="sm"
        _focus={{ transform: 'translateY(0)' }}
      >
        {t('nav.skipToContent')}
      </Box>
      <Flex
        as="aside"
        aria-label={t('nav.primaryLabel')}
        className="console-rail"
        direction="column"
        position={{ base: 'static', lg: 'sticky' }}
        top="0"
        h={{ base: 'auto', lg: '100vh' }}
        px={{ base: 4, lg: 5 }}
        py={{ base: '14px', lg: 6 }}
        borderRightWidth={{ base: '0', lg: '1px' }}
        borderBottomWidth={{ base: '1px', lg: '0' }}
        borderColor="kn.line"
        bg="kn.surfaceMuted"
        overflowY={{ lg: 'auto' }}
      >
        <Link
          href="/spaces"
          display="grid"
          gridTemplateColumns="32px 1fr"
          gap="11px"
          alignItems="center"
          mb={{ base: '14px', lg: 8 }}
          color="kn.ink"
          textDecoration="none"
          _hover={{ textDecoration: 'none' }}
        >
          <Flex
            boxSize="32px"
            align="center"
            justify="center"
            bg="kn.primary"
            color="kn.surface"
            fontSize="lg"
            fontWeight="700"
            borderRadius="sm"
          >
            {t('brand.mark')}
          </Flex>
          <Box>
            <Text as="strong" display="block" fontSize="md">
              {t('brand.name')}
            </Text>
            <Text display="block" mt="2px" color="kn.inkMuted" fontSize="xs">
              {t('brand.subtitle')}
            </Text>
          </Box>
        </Link>

        <Box
          as="nav"
          className="rail-nav"
          display="grid"
          gridTemplateColumns={{ base: 'repeat(2, minmax(0, 1fr))', lg: '1fr' }}
          gap={{ base: 1, lg: 7 }}
        >
          <Box display={{ base: 'contents', lg: 'grid' }} gap={0}>
            <Text
              display={{ base: 'none', lg: 'block' }}
              m={0}
              mb={2}
              color="kn.inkMuted"
              fontSize="xs"
              textTransform="uppercase"
            >
              {t('nav.workspace')}
            </Text>
            <Box
              as="a"
              href="/spaces"
              aria-current={props.location.pathname.startsWith('/spaces') ? 'page' : undefined}
              {...navLink(props.location.pathname.startsWith('/spaces'))}
            >
              <Text
                as="span"
                display={{ base: 'none', lg: 'block' }}
                color="currentColor"
                fontSize="xs"
              >
                {t('nav.spacesCode')}
              </Text>
              <Text as="span">{t('nav.spaces')}</Text>
            </Box>
            <Box
              as="a"
              href="/system/status"
              aria-current={props.location.pathname === '/system/status' ? 'page' : undefined}
              {...navLink(props.location.pathname === '/system/status')}
            >
              <Text
                as="span"
                display={{ base: 'none', lg: 'block' }}
                color="currentColor"
                fontSize="xs"
              >
                {t('nav.systemCode')}
              </Text>
              <Text as="span">{t('nav.systemStatus')}</Text>
            </Box>
            <Box
              as="a"
              href={spaceId ? `/settings/connectors?spaceId=${spaceId}` : '/settings/connectors'}
              aria-current={props.location.pathname === '/settings/connectors' ? 'page' : undefined}
              {...navLink(props.location.pathname === '/settings/connectors')}
            >
              <Text
                as="span"
                display={{ base: 'none', lg: 'block' }}
                color="currentColor"
                fontSize="xs"
              >
                {t('nav.connectorsCode')}
              </Text>
              <Text as="span">{t('nav.connectors')}</Text>
            </Box>
          </Box>

          {spaceLinks.length > 0 ? (
            <Box display={{ base: 'contents', lg: 'grid' }} gap={0}>
              <Text
                display={{ base: 'none', lg: 'block' }}
                m={0}
                mb={2}
                color="kn.inkMuted"
                fontSize="xs"
                textTransform="uppercase"
              >
                {t('nav.currentSpace')}
              </Text>
              {spaceLinks.map(([folio, labelKey, href]) => {
                const active = props.location.pathname === href;
                return (
                  <Box
                    as="a"
                    key={href}
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    {...navLink(active)}
                  >
                    <Text
                      as="span"
                      display={{ base: 'none', lg: 'block' }}
                      color="currentColor"
                      fontSize="xs"
                    >
                      {folio}
                    </Text>
                    <Text as="span">{t(labelKey)}</Text>
                  </Box>
                );
              })}
            </Box>
          ) : null}
        </Box>

        <Box
          className="rail-footer"
          display={{ base: 'none', lg: 'block' }}
          mt="auto"
          pt={6}
          color="kn.inkMuted"
        >
          <Box width="28px" height="2px" mb={3} bg="kn.primary" />
          <Text m={0} color="kn.ink" overflowWrap="anywhere">
            {session
              ? session.workspaceId
              : sessionError
                ? t('shell.sessionUnavailable')
                : t('shell.resolvingWorkspace')}
          </Text>
          <Text as="small" display="block" mt={1} fontSize="xs">
            {t('shell.apiPrefix')}
          </Text>
        </Box>
      </Flex>

      <Box className="console-main" minW={0}>
        <Flex
          as="header"
          className="context-bar"
          minH="68px"
          px={{ base: 4, lg: 8 }}
          py={{ base: '10px', lg: '14px' }}
          borderBottomWidth="1px"
          borderColor="kn.line"
          justify="space-between"
          direction={{ base: 'column', md: 'row' }}
          align={{ base: 'stretch', md: 'center' }}
          gap={{ base: 2, md: 6 }}
          position={{ base: 'static', lg: 'sticky' }}
          top="0"
          zIndex="sticky"
          bg="kn.surface"
        >
          <Box minW={0}>
            <Text color="kn.inkMuted" fontSize="xs">
              {t('shell.knowledgeWorkspace')}
            </Text>
            <Text as="strong" display="block" fontSize="sm" overflowWrap="anywhere">
              {session?.workspaceId ?? t('shell.noWorkspace')}
            </Text>
          </Box>
          <Flex align="center" justify="space-between" gap={3} width={{ base: '100%', md: 'auto' }}>
            <Flex as="div" role="group" aria-label={t('shell.language')} align="center" gap={1}>
              <Button
                size="xs"
                tone={locale === 'zh-CN' ? 'primary' : 'secondary'}
                aria-pressed={locale === 'zh-CN'}
                onClick={() => setLocale('zh-CN')}
              >
                {t('locale.zhCN')}
              </Button>
              <Button
                size="xs"
                tone={locale === 'en' ? 'primary' : 'secondary'}
                aria-pressed={locale === 'en'}
                onClick={() => setLocale('en')}
              >
                {t('locale.en')}
              </Button>
            </Flex>
            <Flex className="context-meta" display={{ base: 'none', md: 'flex' }} gap="18px">
              <Text color="kn.inkMuted" fontSize="xs">
                {session?.isWorkspaceOwner ? t('shell.workspaceOwner') : t('shell.workspaceMember')}
              </Text>
              <Text color="kn.inkMuted" fontSize="xs">
                {t('shell.runtimeSubset')}
              </Text>
            </Flex>
          </Flex>
        </Flex>
        <Box
          as="main"
          id="knowledge-main"
          className="console-content"
          tabIndex={-1}
          width="min(1180px, 100%)"
          px={{ base: 4, md: 6, lg: 8 }}
          pt={{ base: 6, lg: 10 }}
          pb={{ base: '52px', lg: '72px' }}
        >
          {props.children}
        </Box>
      </Box>
    </Box>
  );
}
