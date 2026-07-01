import { useState } from 'react'
import { DownloadIcon, Loader2Icon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { fetchPositions } from '@/lib/api'
import {
  buildExportBundle,
  buildMarketSummaries,
  downloadFile,
  exportFilename,
  fetchAllTradeHistory,
  fillsToCsv,
  fillsToJson,
  summariesToCsv,
} from '@/lib/exportHistory'

type ExportKind = 'fills-csv' | 'fills-json' | 'summary-csv' | 'bundle-json'

const CSV_MIME = 'text/csv;charset=utf-8'
const JSON_MIME = 'application/json'

/**
 * Downloads the full filled-order ledger (every Data-API page, not just the
 * scrolled-in ones) as CSV/JSON, plus derived per-market P&L summaries.
 */
export function ExportHistoryButton() {
  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState(0)

  const runExport = async (kind: ExportKind) => {
    setExporting(true)
    setProgress(0)
    try {
      const { fills, truncated } = await fetchAllTradeHistory(setProgress)
      if (fills.length === 0) {
        toast.info('No fills to export yet.')
        return
      }

      if (kind === 'fills-csv') {
        downloadFile(exportFilename('fills', 'csv'), fillsToCsv(fills), CSV_MIME)
      } else if (kind === 'fills-json') {
        downloadFile(exportFilename('fills', 'json'), fillsToJson(fills, truncated), JSON_MIME)
      } else if (kind === 'summary-csv') {
        downloadFile(
          exportFilename('markets', 'csv'),
          summariesToCsv(buildMarketSummaries(fills)),
          CSV_MIME,
        )
      } else {
        // Positions add avgPrice/cashPnl/redeemable context; export the ledger anyway
        // if that call fails (`positions_snapshot: null` marks the gap).
        const positions = await fetchPositions().catch(() => null)
        downloadFile(
          exportFilename('full', 'json'),
          buildExportBundle(fills, truncated, positions),
          JSON_MIME,
        )
        if (positions === null) toast.warning('Positions snapshot failed — exported without it.')
      }

      toast.success(
        `Exported ${fills.length} fill${fills.length === 1 ? '' : 's'}${
          truncated ? ' (server caps history at 10,000)' : ''
        }.`,
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Export failed.')
    } finally {
      setExporting(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="xs" variant="outline" disabled={exporting}>
          {exporting ? (
            <>
              <Loader2Icon className="animate-spin" />
              {progress > 0 ? `${progress} fills…` : 'Exporting…'}
            </>
          ) : (
            <>
              <DownloadIcon />
              Export
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Export full history</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => void runExport('fills-csv')}>
          Fills — CSV
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void runExport('fills-json')}>
          Fills — JSON
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void runExport('summary-csv')}>
          Per-market P&L — CSV
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void runExport('bundle-json')}>
          Everything — JSON
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
