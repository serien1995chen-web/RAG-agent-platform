'use client';

import {
  AttachmentIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  HamburgerIcon,
  InfoOutlineIcon,
  LockIcon,
  RepeatIcon,
  SearchIcon,
  SettingsIcon,
  TimeIcon,
  ViewIcon,
  WarningIcon,
} from '@chakra-ui/icons';
import {
  Box,
  Flex,
  Input,
  InputGroup,
  InputLeftElement,
  Modal,
  ModalBody,
  ModalContent,
  ModalOverlay,
  Text,
  useDisclosure,
} from '@chakra-ui/react';
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { ensureConsoleSession, type ConsoleSession } from '../client/knowledge-client';
import { useKnowledgeI18n, type MessageKey } from '../i18n';
import { knowledgeQueryKeys } from '../query/query-keys';
import { useKnowledgeQuery } from '../query/use-knowledge-query';
import { Button } from './knowledge-primitives';

export interface ShellLocation {
  pathname: string;
  query: Record<string, string | string[] | undefined>;
}

export interface KnowledgeAppShellProps {
  location: ShellLocation;
  children: ReactNode;
  onNavigate?: (href: string) => void;
}

interface NavigationItem {
  href: string;
  labelKey: MessageKey;
  icon: ComponentType;
  section: 'global' | 'space';
}

interface CommandItem {
  id: string;
  label: string;
  hint: string;
  href: string;
  icon: ComponentType;
}

interface SpaceSummary {
  id: string;
  name: string;
  kind: 'space' | 'folder';
}

function queryString(
  query: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const value = query[key];
  return Array.isArray(value) ? value[0] : value;
}

function navLabel(active: boolean) {
  return {
    minHeight: '38px',
    display: 'grid',
    gridTemplateColumns: '28px minmax(0, 1fr)',
    alignItems: 'center',
    gap: '8px',
    px: 2,
    py: '7px',
    color: active ? 'kn.surface' : undefined,
    bg: active ? 'rgba(255,255,255,0.10)' : 'transparent',
    borderLeftWidth: '2px',
    borderLeftColor: active ? 'kn.accent' : 'transparent',
    fontWeight: active ? '650' : '450',
    textDecoration: 'none',
    transition: 'background-color 120ms ease, color 120ms ease',
  } as const;
}

function pageLabelKey(pathname: string): MessageKey {
  if (pathname.endsWith('/overview')) return 'nav.overview';
  if (pathname.endsWith('/sources')) return 'nav.sources';
  if (pathname.endsWith('/import')) return 'nav.import';
  if (pathname.includes('/segments/')) return 's6.segment.title';
  if (pathname.endsWith('/segments')) return 'nav.segments';
  if (pathname.endsWith('/jobs')) return 'nav.jobs';
  if (pathname.endsWith('/search')) return 'nav.search';
  if (pathname.endsWith('/images')) return 'nav.images';
  if (pathname.endsWith('/tags')) return 'nav.tags';
  if (pathname.endsWith('/access')) return 'nav.access';
  if (pathname.endsWith('/synonyms')) return 'nav.synonyms';
  if (pathname === '/usage') return 'nav.usage';
  if (pathname === '/audit') return 'nav.audit';
  if (pathname === '/system/status') return 'nav.systemStatus';
  if (pathname === '/settings/api-keys') return 'nav.apiKeys';
  if (pathname === '/settings/connectors') return 'nav.connectors';
  if (pathname === '/spaces/new') return 'newSpace.heading';
  return 'nav.spaces';
}

const GLOBAL_NAVIGATION: readonly NavigationItem[] = [
  { href: '/spaces', labelKey: 'nav.spaces', icon: CopyIcon, section: 'global' },
  { href: '/usage', labelKey: 'nav.usage', icon: TimeIcon, section: 'global' },
  { href: '/audit', labelKey: 'nav.audit', icon: WarningIcon, section: 'global' },
  {
    href: '/system/status',
    labelKey: 'nav.systemStatus',
    icon: InfoOutlineIcon,
    section: 'global',
  },
  {
    href: '/settings/api-keys',
    labelKey: 'nav.apiKeys',
    icon: LockIcon,
    section: 'global',
  },
];

const SPACE_NAVIGATION: readonly NavigationItem[] = [
  { href: 'overview', labelKey: 'nav.overview', icon: ViewIcon, section: 'space' },
  { href: 'sources', labelKey: 'nav.sources', icon: AttachmentIcon, section: 'space' },
  { href: 'import', labelKey: 'nav.import', icon: DownloadIcon, section: 'space' },
  { href: 'segments', labelKey: 'nav.segments', icon: CopyIcon, section: 'space' },
  { href: 'tags', labelKey: 'nav.tags', icon: AttachmentIcon, section: 'space' },
  { href: 'access', labelKey: 'nav.access', icon: LockIcon, section: 'space' },
  { href: 'jobs', labelKey: 'nav.jobs', icon: TimeIcon, section: 'space' },
  { href: 'search', labelKey: 'nav.search', icon: SearchIcon, section: 'space' },
  { href: 'images', labelKey: 'nav.images', icon: ViewIcon, section: 'space' },
  { href: 'synonyms', labelKey: 'nav.synonyms', icon: RepeatIcon, section: 'space' },
];

function ShellAnchor(props: {
  href: string;
  active: boolean;
  collapsed: boolean;
  icon: ComponentType;
  children: ReactNode;
  onNavigate?: (href: string) => void;
  onSelect?: () => void;
}) {
  const Icon = props.icon;
  return (
    <Box
      as="a"
      href={props.href}
      aria-current={props.active ? 'page' : undefined}
      title={props.collapsed ? String(props.children) : undefined}
      {...navLabel(props.active)}
      onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
        if (!props.onNavigate) return;
        event.preventDefault();
        props.onSelect?.();
        props.onNavigate(props.href);
      }}
    >
      <Flex boxSize="28px" align="center" justify="center" color="currentColor">
        <Icon />
      </Flex>
      <Text
        as="span"
        display={props.collapsed ? 'none' : 'block'}
        overflow="hidden"
        textOverflow="ellipsis"
        whiteSpace="nowrap"
      >
        {props.children}
      </Text>
    </Box>
  );
}

export function KnowledgeAppShell(props: KnowledgeAppShellProps) {
  const { locale, setLocale, t } = useKnowledgeI18n();
  const commandDialog = useDisclosure();
  const commandInput = useRef<HTMLInputElement>(null);
  const [session, setSession] = useState<ConsoleSession | null>(null);
  const [sessionError, setSessionError] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [activeCommand, setActiveCommand] = useState(0);
  const spaceId = queryString(props.location.query, 'spaceId');
  const admin =
    session?.isWorkspaceOwner === true || session?.scopes.includes('knowledge:admin') === true;
  const spaces = useKnowledgeQuery<{ items: SpaceSummary[] }>(
    knowledgeQueryKeys.spaces.list({ limit: 200, sort: '-updatedAt', shell: true }),
    '/v1/knowledge/spaces?limit=200&sort=-updatedAt',
  );
  const currentSpace =
    spaces.data?.items.find((space) => space.id === spaceId) ??
    (spaceId ? { id: spaceId, name: spaceId, kind: 'space' as const } : undefined);

  useEffect(() => {
    let active = true;
    void ensureConsoleSession()
      .then((value) => {
        if (active) {
          setSession(value);
          setSessionError(false);
        }
      })
      .catch(() => {
        if (active) setSessionError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        commandDialog.onOpen();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [commandDialog]);

  useEffect(() => {
    setMobileOpen(false);
  }, [props.location.pathname, spaceId]);

  useEffect(() => {
    setActiveCommand(0);
  }, [commandQuery, commandDialog.isOpen]);

  const navigate = (href: string) => {
    if (props.onNavigate) {
      props.onNavigate(href);
      return;
    }
    window.location.assign(href);
  };

  const globalNavigation = admin
    ? GLOBAL_NAVIGATION
    : GLOBAL_NAVIGATION.filter((item) => item.href === '/spaces');
  const spaceNavigation = spaceId
    ? SPACE_NAVIGATION.map((item) => ({
        ...item,
        href: `/spaces/${spaceId}/${item.href}`,
      }))
    : [];
  const connectorHref = spaceId
    ? `/settings/connectors?spaceId=${spaceId}`
    : '/settings/connectors';
  const navigation = [
    ...globalNavigation,
    ...(admin
      ? [
          {
            href: connectorHref,
            labelKey: 'nav.connectors' as const,
            icon: SettingsIcon,
            section: 'global' as const,
          },
        ]
      : []),
    ...spaceNavigation,
  ];
  const commandItems: CommandItem[] = [
    ...navigation.map((item) => ({
      id: `nav:${item.href}`,
      label: t(item.labelKey),
      hint: item.section === 'space' ? (currentSpace?.name ?? spaceId ?? '') : 'RAG-agent-platform',
      href: item.href,
      icon: item.icon,
    })),
    ...(spaces.data?.items ?? []).map((space) => ({
      id: `space:${space.id}`,
      label: space.name,
      hint: space.kind === 'folder' ? t('enum.folder') : t('enum.space'),
      href: `/spaces/${space.id}/overview`,
      icon: space.kind === 'folder' ? AttachmentIcon : CopyIcon,
    })),
    ...(admin
      ? [
          {
            id: 'action:new-space',
            label: t('spaces.new'),
            hint: t('nav.spaces'),
            href: '/spaces/new',
            icon: CopyIcon,
          },
        ]
      : []),
  ];
  const normalizedCommand = commandQuery.trim().toLocaleLowerCase(locale);
  const filteredCommands = normalizedCommand
    ? commandItems.filter(
        (item) =>
          item.label.toLocaleLowerCase(locale).includes(normalizedCommand) ||
          item.hint.toLocaleLowerCase(locale).includes(normalizedCommand),
      )
    : commandItems;
  const activeItem = filteredCommands[activeCommand];
  const crumbLabel = t(pageLabelKey(props.location.pathname));

  const onCommandKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveCommand((current) =>
        filteredCommands.length === 0 ? 0 : (current + 1) % filteredCommands.length,
      );
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveCommand((current) =>
        filteredCommands.length === 0
          ? 0
          : (current - 1 + filteredCommands.length) % filteredCommands.length,
      );
      return;
    }
    if (event.key === 'Enter' && activeItem) {
      event.preventDefault();
      commandDialog.onClose();
      navigate(activeItem.href);
    }
  };

  return (
    <Box
      className="console-shell"
      minH="100vh"
      display={{ base: 'block', lg: 'grid' }}
      gridTemplateColumns={
        collapsed ? { lg: '72px minmax(0, 1fr)' } : { lg: '236px minmax(0, 1fr)' }
      }
    >
      <Box
        as="a"
        className="skip-link"
        href="#knowledge-main"
        position="fixed"
        top="8px"
        left="8px"
        zIndex="modal"
        px={3}
        py={2}
        bg="kn.ink"
        color="kn.surface"
        opacity={0}
        pointerEvents="none"
        transform="translateY(-160%)"
        borderRadius="sm"
        _focus={{ opacity: 1, pointerEvents: 'auto', transform: 'translateY(0)' }}
        _focusVisible={{ opacity: 1, pointerEvents: 'auto', transform: 'translateY(0)' }}
      >
        {t('nav.skipToContent')}
      </Box>

      {mobileOpen ? (
        <button
          type="button"
          className="mobile-rail-scrim"
          aria-label={t('common.close')}
          onClick={() => setMobileOpen(false)}
        />
      ) : null}

      <Flex
        as="aside"
        aria-label={t('nav.primaryLabel')}
        className="console-rail"
        direction="column"
        position={{ base: 'fixed', lg: 'sticky' }}
        top="0"
        left="0"
        h="100vh"
        width={{ base: 'min(286px, 86vw)', lg: collapsed ? '72px' : '236px' }}
        px={collapsed ? 2 : { base: 4, lg: 4 }}
        py={4}
        borderRightWidth="1px"
        borderColor="rgba(255,255,255,0.10)"
        overflowY="auto"
        transform={{
          base: mobileOpen ? 'translateX(0)' : 'translateX(-105%)',
          lg: 'translateX(0)',
        }}
      >
        <Flex align="center" justify="space-between" gap={2} mb={5}>
          <Flex
            as="a"
            href="/spaces"
            className="brand-lockup"
            align="center"
            gap={3}
            minW={0}
            color="kn.surface"
            textDecoration="none"
            _hover={{ textDecoration: 'none' }}
            onClick={(event) => {
              if (!props.onNavigate) return;
              event.preventDefault();
              navigate('/spaces');
            }}
          >
            <Flex
              boxSize="34px"
              align="center"
              justify="center"
              bg="kn.primary"
              color="kn.surface"
              fontSize="md"
              fontWeight="750"
              borderRadius="sm"
              className="brand-lockup__mark"
            >
              {t('brand.mark')}
            </Flex>
            {!collapsed ? (
              <Box minW={0}>
                <Text
                  as="strong"
                  display="block"
                  fontSize="13px"
                  lineHeight="1.2"
                  overflowWrap="anywhere"
                >
                  {t('brand.name')}
                </Text>
                <Text as="span" display="block" mt="1px" fontSize="xs" opacity={0.8}>
                  {t('brand.subtitle')}
                </Text>
              </Box>
            ) : null}
          </Flex>
          {!collapsed ? (
            <Button
              size="xs"
              aria-label={t('common.close')}
              display={{ base: 'inline-flex', lg: 'none' }}
              onClick={() => setMobileOpen(false)}
            >
              <HamburgerIcon />
            </Button>
          ) : null}
        </Flex>

        {!collapsed ? (
          <Flex
            className="space-switcher"
            align="center"
            justify="space-between"
            gap={2}
            mb={4}
            px={3}
            py={2}
            borderWidth="1px"
            borderColor="rgba(255,255,255,0.12)"
            borderRadius="sm"
            bg="rgba(255,255,255,0.05)"
          >
            <Box minW={0}>
              <Text display="block" fontSize="xs" opacity={0.8}>
                {t('nav.currentSpace')}
              </Text>
              <Text
                as="strong"
                display="block"
                mt="2px"
                fontSize="sm"
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
              >
                {currentSpace?.name ?? (spaceId ? spaceId : t('shell.noWorkspace'))}
              </Text>
            </Box>
            <ChevronRightIcon />
          </Flex>
        ) : null}

        <Box as="nav" className="rail-nav" display="grid" gridTemplateColumns="1fr" gap={6}>
          <Box display="grid" gap="2px">
            {!collapsed ? (
              <Text
                m={0}
                mb={2}
                px={2}
                color="rgba(255,255,255,0.72)"
                fontSize="10px"
                fontWeight="700"
                textTransform="uppercase"
                letterSpacing="0"
              >
                {t('nav.workspace')}
              </Text>
            ) : null}
            {globalNavigation.map((item) => (
              <ShellAnchor
                key={item.href}
                href={item.href}
                active={
                  item.href === '/spaces'
                    ? props.location.pathname.startsWith('/spaces')
                    : props.location.pathname === item.href
                }
                collapsed={collapsed}
                icon={item.icon}
                onNavigate={props.onNavigate}
                onSelect={() => setMobileOpen(false)}
              >
                {t(item.labelKey)}
              </ShellAnchor>
            ))}
            {admin ? (
              <ShellAnchor
                href={connectorHref}
                active={props.location.pathname === '/settings/connectors'}
                collapsed={collapsed}
                icon={SettingsIcon}
                onNavigate={props.onNavigate}
                onSelect={() => setMobileOpen(false)}
              >
                {t('nav.connectors')}
              </ShellAnchor>
            ) : null}
          </Box>

          {spaceNavigation.length > 0 ? (
            <Box display="grid" gap="2px">
              {!collapsed ? (
                <Text
                  m={0}
                  mb={2}
                  px={2}
                  color="rgba(255,255,255,0.72)"
                  fontSize="10px"
                  fontWeight="700"
                  textTransform="uppercase"
                  letterSpacing="0"
                >
                  {t('nav.currentSpace')}
                </Text>
              ) : null}
              {spaceNavigation.map((item) => (
                <ShellAnchor
                  key={item.href}
                  href={item.href}
                  active={
                    props.location.pathname === item.href ||
                    (item.href.endsWith('/segments') &&
                      props.location.pathname.includes('/segments/'))
                  }
                  collapsed={collapsed}
                  icon={item.icon}
                  onNavigate={props.onNavigate}
                  onSelect={() => setMobileOpen(false)}
                >
                  {t(item.labelKey)}
                </ShellAnchor>
              ))}
            </Box>
          ) : null}
        </Box>

        <Box mt="auto" pt={5}>
          <Button
            width="100%"
            size="xs"
            display={{ base: 'none', lg: 'flex' }}
            aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
            onClick={() => setCollapsed((value) => !value)}
            color="kn.surface"
            borderColor="rgba(255,255,255,0.16)"
            _hover={{
              color: 'kn.surface',
              borderColor: 'rgba(255,255,255,0.32)',
              bg: 'rgba(255,255,255,0.08)',
            }}
          >
            <ChevronLeftIcon boxSize={4} transform={collapsed ? 'rotate(180deg)' : undefined} />
            {!collapsed ? <Text as="span">{t('nav.collapse')}</Text> : null}
          </Button>
          {!collapsed ? (
            <Box className="rail-footer" mt={4} px={2} pb={1} fontSize="xs">
              <Text as="strong" display="block" fontSize="xs" overflowWrap="anywhere">
                {session
                  ? session.workspaceId
                  : sessionError
                    ? t('shell.sessionUnavailable')
                    : t('shell.resolvingWorkspace')}
              </Text>
              <Text as="span" display="block" mt={1} opacity={0.8}>
                {t('shell.apiPrefix')}
              </Text>
            </Box>
          ) : null}
        </Box>
      </Flex>

      <Box className="console-main" minW={0}>
        <Flex
          as="header"
          className="context-bar"
          minH="64px"
          px={{ base: 3, md: 5, lg: 7 }}
          py={2}
          borderBottomWidth="1px"
          borderColor="kn.line"
          justify="space-between"
          direction="row"
          align="center"
          gap={{ base: 2, md: 5 }}
          position="sticky"
          top="0"
          zIndex="sticky"
        >
          <Flex align="center" gap={{ base: 2, md: 4 }} minW={0}>
            <Button
              size="sm"
              aria-label={t('nav.openMenu')}
              display={{ base: 'inline-flex', lg: 'none' }}
              onClick={() => setMobileOpen(true)}
            >
              <HamburgerIcon />
            </Button>
            <Box className="context-bar__main">
              <Box className="context-bar__crumb">
                <Text as="span" color="kn.inkMuted" fontSize="xs">
                  {t('brand.name')}
                </Text>
                <ChevronRightIcon boxSize={3} color="kn.inkMuted" />
                <Text
                  as="span"
                  color={spaceId ? 'kn.inkMuted' : 'kn.ink'}
                  fontSize="xs"
                  fontWeight={spaceId ? '450' : '650'}
                >
                  {spaceId ? (currentSpace?.name ?? spaceId) : crumbLabel}
                </Text>
                {spaceId ? (
                  <>
                    <ChevronRightIcon boxSize={3} color="kn.inkMuted" />
                    <Text as="span" color="kn.ink" fontSize="xs" fontWeight="650">
                      {crumbLabel}
                    </Text>
                  </>
                ) : null}
              </Box>
            </Box>
          </Flex>

          <Flex align="center" gap={2}>
            <Button
              className="command-trigger"
              size="sm"
              display={{ base: 'none', md: 'inline-flex' }}
              onClick={commandDialog.onOpen}
            >
              <SearchIcon boxSize={4} />
              <Text as="span" ml={2} fontSize="sm" fontWeight="450">
                {t('command.placeholder')}
              </Text>
              <Text
                as="kbd"
                ml="auto"
                px={2}
                py="2px"
                borderWidth="1px"
                borderColor="kn.line"
                borderRadius="sm"
                bg="kn.surface"
                color="kn.inkMuted"
                fontSize="10px"
              >
                Ctrl K
              </Text>
            </Button>
            <Button
              size="sm"
              aria-label={t('command.open')}
              display={{ base: 'inline-flex', md: 'none' }}
              onClick={commandDialog.onOpen}
            >
              <SearchIcon />
            </Button>
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
            <Box
              className="context-meta"
              display={{ base: 'none', xl: 'block' }}
              pl={3}
              borderLeftWidth="1px"
              borderColor="kn.line"
            >
              <Text color="kn.inkMuted" fontSize="10px">
                {session?.memberId ?? t('shell.noWorkspace')}
              </Text>
              <Text color="kn.ink" fontSize="xs" fontWeight="600">
                {session?.isWorkspaceOwner ? t('shell.workspaceOwner') : t('shell.workspaceMember')}
              </Text>
            </Box>
          </Flex>
        </Flex>

        <Box
          as="main"
          id="knowledge-main"
          className="console-content"
          tabIndex={-1}
          px={{ base: 4, md: 6, lg: 8, xl: 10 }}
          pt={{ base: 6, lg: 8 }}
          pb={{ base: '52px', lg: '72px' }}
        >
          {props.children}
        </Box>
      </Box>

      <Modal
        isOpen={commandDialog.isOpen}
        onClose={commandDialog.onClose}
        initialFocusRef={commandInput}
        size="xl"
        isCentered
        motionPreset="scale"
      >
        <ModalOverlay bg="rgba(20,39,43,0.58)" backdropFilter="blur(4px)" />
        <ModalContent
          className="command-dialog"
          overflow="hidden"
          mt="12vh"
          borderWidth="1px"
          borderColor="kn.line"
          borderRadius="md"
          bg="kn.surface"
          boxShadow="kn2"
        >
          <ModalBody p={0}>
            <InputGroup>
              <InputLeftElement pointerEvents="none" h="56px">
                <SearchIcon color="kn.inkMuted" />
              </InputLeftElement>
              <Input
                ref={commandInput}
                value={commandQuery}
                onChange={(event) => setCommandQuery(event.target.value)}
                onKeyDown={onCommandKeyDown}
                h="56px"
                pl={10}
                pr={4}
                border={0}
                borderRadius={0}
                borderBottomWidth="1px"
                borderColor="kn.line"
                bg="kn.surface"
                placeholder={t('command.placeholder')}
                aria-label={t('command.placeholder')}
                aria-controls="knowledge-command-results"
                aria-activedescendant={
                  activeItem
                    ? `knowledge-command-${activeItem.id.replace(/[^\w-]/g, '-')}`
                    : undefined
                }
                autoComplete="off"
              />
            </InputGroup>
            <Box id="knowledge-command-results" className="command-dialog__results" p={2}>
              {filteredCommands.length === 0 ? (
                <Text m={0} px={3} py={8} color="kn.inkMuted" textAlign="center">
                  {t('command.noResults')}
                </Text>
              ) : (
                filteredCommands.map((item, index) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      id={`knowledge-command-${item.id.replace(/[^\w-]/g, '-')}`}
                      type="button"
                      className="command-result"
                      data-active={index === activeCommand}
                      onMouseEnter={() => setActiveCommand(index)}
                      onClick={() => {
                        commandDialog.onClose();
                        navigate(item.href);
                      }}
                    >
                      <Icon />
                      <Text as="span" minW={0} overflow="hidden" textOverflow="ellipsis">
                        {item.label}
                      </Text>
                      <Text as="small" maxW="42%" overflow="hidden" textOverflow="ellipsis">
                        {item.hint}
                      </Text>
                    </button>
                  );
                })
              )}
            </Box>
            <Flex
              align="center"
              justify="space-between"
              px={4}
              py={2}
              borderTopWidth="1px"
              borderColor="kn.line"
              color="kn.inkMuted"
              fontSize="xs"
            >
              <Text as="span">{t('command.hint')}</Text>
              <Text as="span">{t('command.closeHint')}</Text>
            </Flex>
          </ModalBody>
        </ModalContent>
      </Modal>
    </Box>
  );
}
