import { Badge } from '@/components/ui/badge'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { AssessmentItem, ScaffoldingItem } from '@/types'

function isGroup(item: AssessmentItem) {
  return /\bgroup\b/i.test(item.assessment_type)
}

function number(value: number) {
  return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function partLabels(items: AssessmentItem[]) {
  const totals = new Map<string, number>()
  const seen = new Map<string, number>()
  for (const item of items) {
    const key = `${item.subject_code}|${item.assessment_name}`.toLowerCase()
    totals.set(key, (totals.get(key) ?? 0) + 1)
  }
  return items.map((item) => {
    const key = `${item.subject_code}|${item.assessment_name}`.toLowerCase()
    const next = (seen.get(key) ?? 0) + 1
    seen.set(key, next)
    const explicit = item.component && !/^(whole assessment|assessment)$/i.test(item.component)
    if (explicit) return item.component
    return (totals.get(key) ?? 0) > 1 ? `Part ${String.fromCharCode(64 + next)}` : ''
  })
}

function Matrix({ items, weeks, outlineOnly, coverageEvaluations }: { items: AssessmentItem[]; weeks: number; outlineOnly: boolean; coverageEvaluations: ScaffoldingItem[] }) {
  const labels = partLabels(items)
  const subjects = Array.from(new Map(items.map((item) => [
    item.subject_code || 'Unassigned',
    item.subject_name || 'Unit not identified',
  ])).entries())

  return (
    <ScrollArea className="w-full rounded-lg border bg-card">
      <Table className="min-w-[1080px]">
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-20 min-w-44 bg-muted">Unit</TableHead>
            {Array.from({ length: weeks }, (_, index) => <TableHead key={index} className="min-w-44">Week {index + 1}</TableHead>)}
            <TableHead className="min-w-32">Number of Methods</TableHead>
            <TableHead className="min-w-36">Individual assessments %</TableHead>
            <TableHead className="min-w-32">Group assessments %</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {subjects.map(([code, name]) => {
            const unitItems = items.filter((item) => (item.subject_code || 'Unassigned') === code)
            const methods = new Set(unitItems.map((item) => item.assessment_name.trim().toLowerCase())).size
            const individual = unitItems.filter((item) => !isGroup(item)).reduce((sum, item) => sum + Number(item.weight || 0), 0)
            const group = unitItems.filter(isGroup).reduce((sum, item) => sum + Number(item.weight || 0), 0)
            return (
              <TableRow key={code} className="align-top">
                <TableCell className="sticky left-0 z-10 bg-card font-medium">
                  <div>{code}</div><div className="mt-1 text-xs font-normal text-muted-foreground">{name}</div>
                </TableCell>
                {Array.from({ length: weeks }, (_, weekIndex) => (
                  <TableCell key={weekIndex} className="p-2">
                    <div className="space-y-2">
                      {unitItems.map((item) => ({ item, sourceIndex: items.indexOf(item) }))
                        .filter(({ item }) => Number(item.due_week) === weekIndex + 1)
                        .map(({ item, sourceIndex }) => {
                          const coverage = coverageEvaluations[sourceIndex]
                          const coverageClass = coverage?.status === 'success'
                            ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30'
                            : coverage?.status === 'warning'
                              ? 'border-primary/40 bg-primary/10'
                              : 'border-destructive/40 bg-destructive/10'
                          const coverageTextClass = coverage?.status === 'success'
                            ? 'text-emerald-700 dark:text-emerald-300'
                            : coverage?.status === 'warning'
                              ? 'text-primary'
                              : 'text-destructive'

                          return (
                          <div key={`${sourceIndex}-${item.assessment_name}`} className={`rounded-md border p-2.5 text-xs ${outlineOnly ? 'border-destructive/40 bg-destructive/10' : coverageClass}`}>
                            <div className="font-semibold text-foreground">{item.assessment_name}{labels[sourceIndex] ? ` — ${labels[sourceIndex]}` : ''}</div>
                            <div className="mt-1 text-muted-foreground">{number(item.weight)}% · Due after Session {item.due_session || '—'}</div>
                            {outlineOnly && <div className="mt-1.5 font-medium text-destructive">Outline information · No assessment brief provided</div>}
                            {!outlineOnly && coverage && <div className={`mt-1.5 font-medium ${coverageTextClass}`}>Topic coverage · {coverage.label}</div>}
                          </div>
                          )
                        })}
                    </div>
                  </TableCell>
                ))}
                <TableCell><Badge variant="secondary">{methods}</Badge></TableCell>
                <TableCell className="font-medium">{number(individual)}%</TableCell>
                <TableCell className="font-medium">{number(group)}%</TableCell>
              </TableRow>
            )
          })}
          {!subjects.length && <TableRow><TableCell colSpan={weeks + 4} className="h-32 text-center text-muted-foreground">No scheduled assessments yet.</TableCell></TableRow>}
        </TableBody>
      </Table>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  )
}

export function ScheduleMatrix({ items, weeks, outlineOnly = false, coverageEvaluations = [] }: { items: AssessmentItem[]; weeks: number; outlineOnly?: boolean; coverageEvaluations?: ScaffoldingItem[] }) {
  return <Matrix items={items} weeks={weeks} outlineOnly={outlineOnly} coverageEvaluations={coverageEvaluations} />
}
