'use client';

import {
  Box,
  Button as ChakraButton,
  ButtonGroup,
  Flex,
  Popover,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
  Portal,
  Stack,
  Table,
  TableCaption,
  TableContainer,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr,
} from '@chakra-ui/react';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type VisibilityState,
} from '@tanstack/react-table';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { useKnowledgeI18n } from '../i18n';
import { Button } from './knowledge-primitives';

export type Density = 'compact' | 'standard' | 'comfortable';

export interface Column<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  enableHiding?: boolean;
}

export interface TablePagination {
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}

export interface KnowledgeDataTableProps<T> {
  rows: readonly T[];
  columns: readonly Column<T>[];
  rowKey: (row: T) => string;
  empty: string;
  caption?: string;
  pagination?: TablePagination;
}

const densityPadding: Record<Density, string> = {
  compact: '6px 8px',
  standard: '10px',
  comfortable: '14px 12px',
};

export function KnowledgeDataTable<T>(props: KnowledgeDataTableProps<T>) {
  const { t } = useKnowledgeI18n();
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [density, setDensity] = useState<Density>('standard');
  const data = useMemo(() => [...props.rows], [props.rows]);
  const latestColumns = useRef(props.columns);
  latestColumns.current = props.columns;
  const latestRowKey = useRef(props.rowKey);
  latestRowKey.current = props.rowKey;
  const columnSignature = props.columns
    .map((column) => `${column.key}\u0000${column.label}\u0000${column.enableHiding ?? true}`)
    .join('\u0001');
  const tableColumns = useMemo<ColumnDef<T>[]>(
    () =>
      latestColumns.current.map((column, index) => ({
        id: column.key,
        accessorFn: (row) => row,
        header: column.label,
        cell: (context) => latestColumns.current[index]?.render(context.row.original),
        enableHiding: column.enableHiding ?? true,
      })),
    [columnSignature],
  );
  const stableRowKey = useCallback((row: T) => latestRowKey.current(row), []);
  const table = useReactTable({
    data,
    columns: tableColumns,
    state: { columnVisibility },
    onColumnVisibilityChange: setColumnVisibility,
    getRowId: stableRowKey,
    getCoreRowModel: getCoreRowModel(),
  });
  const hideableColumns = table.getAllLeafColumns().filter((column) => column.getCanHide());

  return (
    <Box width="100%" minW={0}>
      <Flex
        className="table-toolbar"
        align="center"
        justify="space-between"
        gap={3}
        wrap="wrap"
        py={2}
      >
        <Text color="kn.inkMuted" fontSize="xs">
          {t('common.rows', { count: props.rows.length })}
        </Text>
        <Flex align="center" gap={2} wrap="wrap">
          <Popover placement="bottom-end">
            <PopoverTrigger>
              <Button size="sm" aria-label={t('common.columns')}>
                {t('common.columns')}
              </Button>
            </PopoverTrigger>
            <Portal>
              <PopoverContent width="230px" borderColor="kn.line" borderRadius="md" boxShadow="kn1">
                <PopoverBody>
                  <Stack spacing={2}>
                    {hideableColumns.map((column) => (
                      <label
                        key={column.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={column.getIsVisible()}
                          onChange={() =>
                            setColumnVisibility((current) => ({
                              ...current,
                              [column.id]: !column.getIsVisible(),
                            }))
                          }
                        />
                        <span>{String(column.columnDef.header)}</span>
                      </label>
                    ))}
                  </Stack>
                </PopoverBody>
              </PopoverContent>
            </Portal>
          </Popover>
          <ButtonGroup isAttached variant="outline" size="sm">
            {(['compact', 'standard', 'comfortable'] as const).map((value) => (
              <ChakraButton
                key={value}
                type="button"
                aria-pressed={density === value}
                variant={density === value ? 'solid' : 'outline'}
                bg={density === value ? 'kn.primary' : 'kn.surface'}
                color={density === value ? 'kn.surface' : 'kn.ink'}
                borderColor={density === value ? 'kn.primary' : 'kn.line'}
                onClick={() => setDensity(value)}
              >
                {value === 'compact'
                  ? t('common.compact')
                  : value === 'standard'
                    ? t('common.standard')
                    : t('common.relaxed')}
              </ChakraButton>
            ))}
          </ButtonGroup>
        </Flex>
      </Flex>
      <TableContainer
        className="table-scroll"
        width="100%"
        maxW="100%"
        overflowX="auto"
        tabIndex={0}
        borderTopWidth="1px"
        borderColor="kn.line"
      >
        <Table
          size={density === 'compact' ? 'sm' : 'md'}
          variant="simple"
          minW="680px"
          aria-label={props.caption ?? t('common.dataTable')}
        >
          <TableCaption>{props.caption ?? t('common.dataTable')}</TableCaption>
          <Thead position="sticky" top={0} zIndex="docked" bg="kn.surface">
            {table.getHeaderGroups().map((headerGroup) => (
              <Tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <Th
                    key={header.id}
                    scope="col"
                    position="sticky"
                    top={0}
                    zIndex="docked"
                    bg="kn.surface"
                    px="10px"
                    py={3}
                    color="kn.inkMuted"
                    fontSize="xs"
                    textTransform="uppercase"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </Th>
                ))}
              </Tr>
            ))}
          </Thead>
          <Tbody>
            {table.getRowModel().rows.length === 0 ? (
              <Tr>
                <Td colSpan={table.getVisibleLeafColumns().length || 1} py={8}>
                  <Text m={0} color="kn.inkMuted">
                    {props.empty}
                  </Text>
                </Td>
              </Tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <Tr key={row.id} _hover={{ bg: 'kn.surfaceMuted' }}>
                  {row.getVisibleCells().map((cell) => (
                    <Td
                      key={cell.id}
                      px="10px"
                      py={densityPadding[density].split(' ')[0]}
                      verticalAlign="top"
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </Td>
                  ))}
                </Tr>
              ))
            )}
          </Tbody>
        </Table>
      </TableContainer>
      {props.pagination ? (
        <Flex align="center" justify="flex-end" gap={2} py={3}>
          <Text color="kn.inkMuted" fontSize="xs">
            {t('common.page', { page: props.pagination.page })}
          </Text>
          <Button
            size="sm"
            disabled={!props.pagination.hasPrevious}
            onClick={props.pagination.onPrevious}
          >
            {t('common.previous')}
          </Button>
          <Button size="sm" disabled={!props.pagination.hasNext} onClick={props.pagination.onNext}>
            {t('common.next')}
          </Button>
        </Flex>
      ) : null}
    </Box>
  );
}
