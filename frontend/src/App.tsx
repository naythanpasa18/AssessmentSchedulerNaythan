import { useMemo, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react'
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  CloudUpload,
  Database,
  Download,
  FileText,
  LoaderCircle,
  Moon,
  Plus,
  Printer,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Sun,
  Trash2,
} from 'lucide-react'

import { ScheduleMatrix } from '@/components/schedule-matrix'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  analyseSchedule,
  exportScheduleXml,
  extractUnits,
  generateDraft,
  generateSchedule,
  optimiseSchedule,
  saveSchedule,
} from '@/lib/api'
import type { AssessmentItem, ScaffoldingItem, ScheduleResult, UnitInfo } from '@/types'

const sections = [
  ['unit-upload', '1', 'Upload outline'],
  ['unit-information', '2', 'Unit information'],
  ['extracted-assessments', '4', 'Draft assessments'],
  ['assessment-upload', 'Briefs', 'Assessment briefs'],
  ['learning-sequence', '5', 'Topic coverage'],
  ['weekly-schedule', '6', 'Weekly schedule'],
  ['validation', '7', 'Validation'],
  ['optimization', '8', 'Optimisation'],
  ['academic-review', '9', 'Academic review'],
  ['publish', '10', 'Publish'],
] as const

type WorkflowStepId = typeof sections[number][0]

function cleanFiles(files: File[]) {
  return files.filter((file) => /\.(pdf|docx)$/i.test(file.name))
}

function mergeFiles(current: File[], incoming: File[]) {
  const values = new Map(current.map((file) => [`${file.name}:${file.size}:${file.lastModified}`, file]))
  cleanFiles(incoming).forEach((file) => values.set(`${file.name}:${file.size}:${file.lastModified}`, file))
  return [...values.values()]
}

function normalizeUnit(unit: UnitInfo): UnitInfo {
  const weekly = Array.isArray(unit.weekly_topics) ? unit.weekly_topics : []
  return {
    ...unit,
    learning_outcomes: unit.learning_outcomes ?? [],
    assessment_information: unit.assessment_information ?? [],
    weekly_topics: weekly,
    sessions: Array.isArray(unit.sessions) && unit.sessions.length
      ? unit.sessions.map((session, index) => ({ ...session, session: index + 1 }))
      : weekly.map((topic, index) => ({ session: index + 1, topic: topic.topic, source_week: topic.week })),
    prerequisite_concepts: unit.prerequisite_concepts ?? [],
    teaching_activities: unit.teaching_activities ?? [],
    breaks: unit.breaks ?? [],
    scheduling_constraints: unit.scheduling_constraints ?? [],
  }
}

function assessmentLabel(values: string[], index: number) {
  const base = values[index].match(/\bAssessment\s*\d+/i)?.[0] ?? `Assessment ${index + 1}`
  const related = values.map((value, itemIndex) => ({ itemIndex, base: value.match(/\bAssessment\s*\d+/i)?.[0]?.toLowerCase() }))
    .filter((value) => value.base === base.toLowerCase())
  if (related.length < 2) return base
  const part = related.findIndex((value) => value.itemIndex === index)
  return `${base} Part ${String.fromCharCode(65 + Math.max(part, 0))}`
}

function dueSessionFromText(value: string) {
  return Number(value.match(/\b(?:due\s*(?:after|in|at|by)?\s*|after\s+)session\s*(\d{1,3})\b/i)?.[1] ?? 0)
}

function withDueSession(value: string, session: number) {
  const replacement = session > 0 ? `due after Session ${session}` : ''
  if (/\b(?:due\s*(?:after|in|at|by)?\s*|after\s+)session\s*\d{1,3}\b/i.test(value)) {
    return value.replace(/\b(?:due\s*(?:after|in|at|by)?\s*|after\s+)session\s*\d{1,3}\b/i, replacement).replace(/\s{2,}/g, ' ').trim()
  }
  return [value.trim().replace(/[,;]\s*$/, ''), replacement].filter(Boolean).join(', ')
}

function assessmentMatchScore(detail: AssessmentItem, scheduled: AssessmentItem) {
  const detailCode = detail.subject_code.trim().toLowerCase()
  const scheduledCode = scheduled.subject_code.trim().toLowerCase()
  if (detailCode && scheduledCode && detailCode !== scheduledCode) return -1

  const detailNumber = detail.assessment_name.match(/\bAssessment\s*(\d+)\b/i)?.[1]
  const scheduledNumber = scheduled.assessment_name.match(/\bAssessment\s*(\d+)\b/i)?.[1]
  if (detailNumber && scheduledNumber && detailNumber !== scheduledNumber) return -1

  let score = detailCode && scheduledCode ? 30 : 0
  if (detailNumber && scheduledNumber) score += 100
  const tokens = (value: string) => new Set(
    value.toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => !['assessment', 'part', 'component'].includes(token) && !/^\d+$/.test(token)) ?? [],
  )
  const detailTokens = tokens(detail.assessment_name)
  const scheduledTokens = tokens(scheduled.assessment_name)
  const overlap = [...detailTokens].filter((token) => scheduledTokens.has(token)).length
  if (detailTokens.size && scheduledTokens.size) score += Math.round(50 * overlap / Math.max(detailTokens.size, scheduledTokens.size))
  return score >= 50 ? score : -1
}

function retainReviewedSchedule(data: ScheduleResult, draft: ScheduleResult | null): ScheduleResult {
  if (!draft?.items.length) return data
  const usedScheduled = new Set<number>()
  const items = data.items.map((detail) => {
    const match = draft.items
      .map((scheduled, index) => ({ scheduled, index, score: usedScheduled.has(index) ? -1 : assessmentMatchScore(detail, scheduled) }))
      .filter((candidate) => candidate.score >= 0)
      .sort((left, right) => right.score - left.score)[0]
    if (!match) return detail
    usedScheduled.add(match.index)
    return {
      ...detail,
      subject_code: match.scheduled.subject_code || detail.subject_code,
      subject_name: match.scheduled.subject_name || detail.subject_name,
      assessment_name: match.scheduled.assessment_name || detail.assessment_name,
      component: match.scheduled.component || detail.component,
      assessment_type: match.scheduled.assessment_type !== 'Unspecified' ? match.scheduled.assessment_type : detail.assessment_type,
      weight: match.scheduled.weight || detail.weight,
      due_week: match.scheduled.due_week || detail.due_week,
      due_session: match.scheduled.due_session || detail.due_session,
      raw_due_text: match.scheduled.raw_due_text || detail.raw_due_text,
    }
  })

  const scaffolding = [...data.scaffolding]
  draft.items.forEach((scheduled, index) => {
    if (usedScheduled.has(index)) return
    items.push(scheduled)
    scaffolding.push({
      assessment_name: scheduled.assessment_name,
      component: scheduled.component,
      status: 'warning',
      label: 'Assessment brief required',
      rationale: 'No uploaded assessment brief could be matched to this scheduled assessment.',
      topic_readiness: 'Coverage cannot be evaluated until a matching brief is provided.',
      matched_topics: [],
      requirement_coverage: [],
    })
  })

  const schedule = Array.from({ length: data.course_duration }, (_, weekIndex) => {
    const due = items.filter((item) => Number(item.due_week) === weekIndex + 1)
    return {
      Week: weekIndex + 1,
      'Assessments due': due.map((item) => item.assessment_name).join('; ') || '-',
      'Weight due': due.reduce((total, item) => total + Number(item.weight || 0), 0),
    }
  })
  return { ...data, items, scaffolding, schedule }
}

function Section({ id, step, title, description, action, children }: {
  id: string
  step: string
  title: string
  description: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <Card id={id} className="flex h-[calc(100dvh-220px)] min-h-[560px] max-h-[820px] flex-col overflow-hidden shadow-sm">
      <CardHeader className="border-b bg-muted/25">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <Badge variant="outline" className="mb-1">{step.startsWith('Before') ? step : `Step ${step}`}</Badge>
            <CardTitle className="text-xl">{title}</CardTitle>
            <CardDescription className="max-w-3xl">{description}</CardDescription>
          </div>
          {action}
        </div>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">{children}</CardContent>
    </Card>
  )
}

function FileDrop({ files, onFiles, label, hint }: {
  files: File[]
  onFiles: (files: File[]) => void
  label: string
  hint: string
}) {
  const add = (incoming: File[]) => onFiles(mergeFiles(files, incoming))
  const change = (event: ChangeEvent<HTMLInputElement>) => add(Array.from(event.target.files ?? []))
  const drop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    add(Array.from(event.dataTransfer.files))
  }
  return (
    <div className="space-y-3">
      <Label onDragOver={(event) => event.preventDefault()} onDrop={drop} className="flex min-h-44 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed bg-muted/20 px-6 text-center transition hover:border-primary/50 hover:bg-muted/40">
        <CloudUpload className="size-8 text-primary" />
        <span className="font-semibold">{label}</span>
        <span className="text-sm text-muted-foreground">{hint}</span>
        <Input type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple className="sr-only" onChange={change} />
      </Label>
      {files.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {files.map((file, index) => (
            <div key={`${file.name}-${file.lastModified}`} className="flex items-center gap-3 rounded-lg border px-3 py-2">
              <FileText className="size-4 shrink-0 text-primary" />
              <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{file.name}</div><div className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</div></div>
              <Button variant="ghost" size="icon-sm" aria-label={`Remove ${file.name}`} onClick={() => onFiles(files.filter((_, itemIndex) => itemIndex !== index))}><Trash2 /></Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function App() {
  const [dark, setDark] = useState(false)
  const [unitFiles, setUnitFiles] = useState<File[]>([])
  const [briefFiles, setBriefFiles] = useState<File[]>([])
  const [units, setUnits] = useState<UnitInfo[]>([])
  const [activeUnit, setActiveUnit] = useState(0)
  const [sessionsPerWeek, setSessionsPerWeek] = useState(0)
  const [draft, setDraft] = useState<ScheduleResult | null>(null)
  const [result, setResult] = useState<ScheduleResult | null>(null)
  const [showBriefs, setShowBriefs] = useState(false)
  const [extractionMethod, setExtractionMethod] = useState('rule-based')
  const [ollamaHost, setOllamaHost] = useState('http://localhost:11434')
  const [ollamaModel, setOllamaModel] = useState('gemma4')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState<{ type: 'error' | 'success' | 'warning'; title: string; detail: string } | null>(null)
  const [changes, setChanges] = useState<string[]>([])
  const [reviewer, setReviewer] = useState('')
  const [decision, setDecision] = useState('')
  const [comments, setComments] = useState('')
  const [published, setPublished] = useState(false)
  const [saved, setSaved] = useState('')
  const [activeStep, setActiveStep] = useState<WorkflowStepId>('unit-upload')

  const currentUnit = units[activeUnit]
  const displayResult = result ?? draft
  const totalSessions = Math.max(0, ...units.map((unit) => unit.sessions.length))
  const calculatedWeeks = sessionsPerWeek > 0 ? Math.ceil(totalSessions / sessionsPerWeek) : 0
  const isStepAvailable = (id: WorkflowStepId) => {
    if (id === 'unit-upload') return true
    if (id === 'unit-information' || id === 'assessment-upload') return Boolean(currentUnit)
    if (id === 'extracted-assessments') return Boolean(draft)
    return Boolean(result)
  }
  const goToStep = (id: WorkflowStepId) => {
    if (!isStepAvailable(id)) return
    if (id === 'assessment-upload') setShowBriefs(true)
    setActiveStep(id)
  }
  const moveStep = (direction: -1 | 1) => {
    const currentIndex = sections.findIndex(([id]) => id === activeStep)
    for (let index = currentIndex + direction; index >= 0 && index < sections.length; index += direction) {
      if (isStepAvailable(sections[index][0])) {
        goToStep(sections[index][0])
        return
      }
    }
  }
  const activeStepIndex = sections.findIndex(([id]) => id === activeStep)
  const hasPreviousStep = sections.slice(0, activeStepIndex).some(([id]) => isStepAvailable(id))
  const hasNextStep = sections.slice(activeStepIndex + 1).some(([id]) => isStepAvailable(id))

  const preparedUnits = useMemo(() => units.map((unit) => {
    const weeklyTopics = unit.sessions
      .filter((session) => session.topic.trim())
      .map((session) => ({ week: String(sessionsPerWeek > 0 ? Math.ceil(session.session / sessionsPerWeek) : session.session), topic: session.topic.trim() }))
    return { ...unit, weekly_topics: weeklyTopics, course_duration: calculatedWeeks || unit.course_duration }
  }), [units, sessionsPerWeek, calculatedWeeks])

  const combinedUnit = useMemo<UnitInfo | null>(() => {
    if (!preparedUnits.length) return null
    if (preparedUnits.length === 1) return preparedUnits[0]
    return {
      ...preparedUnits[0],
      unit_code: preparedUnits.map((unit) => unit.unit_code).filter(Boolean).join(', '),
      unit_name: preparedUnits.map((unit) => unit.unit_name).filter(Boolean).join('; '),
      course_duration: calculatedWeeks,
      learning_outcomes: preparedUnits.flatMap((unit) => unit.learning_outcomes.map((value) => `${unit.unit_code}: ${value}`)),
      assessment_information: preparedUnits.flatMap((unit) => unit.assessment_information.map((value) => `${unit.unit_code}: ${value}`)),
      weekly_topics: preparedUnits.flatMap((unit) => unit.weekly_topics.map((value) => ({ ...value, topic: `${unit.unit_code}: ${value.topic}` }))),
      sessions: preparedUnits.flatMap((unit) => unit.sessions),
      prerequisite_concepts: preparedUnits.flatMap((unit) => unit.prerequisite_concepts),
      teaching_activities: preparedUnits.flatMap((unit) => unit.teaching_activities),
      breaks: preparedUnits.flatMap((unit) => unit.breaks),
      scheduling_constraints: preparedUnits.flatMap((unit) => unit.scheduling_constraints),
      source_file: preparedUnits.map((unit) => unit.source_file).join(', '),
    }
  }, [preparedUnits, calculatedWeeks])

  const updateCurrentUnit = (patch: Partial<UnitInfo>) => {
    setUnits((values) => values.map((unit, index) => index === activeUnit ? { ...unit, ...patch } : unit))
    setDraft(null)
    setResult(null)
  }

  const run = async (label: string, task: () => Promise<void>) => {
    setBusy(label)
    setMessage(null)
    try {
      await task()
    } catch (error) {
      setMessage({ type: 'error', title: 'Something needs attention', detail: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy('')
    }
  }

  const extract = () => run('Extracting unit information', async () => {
    const form = new FormData()
    unitFiles.forEach((file) => form.append('files', file))
    form.append('extraction_method', extractionMethod)
    form.append('ollama_host', ollamaHost)
    form.append('ollama_model', ollamaModel)
    const data = await extractUnits(form)
    setUnits(data.units.map(normalizeUnit))
    setActiveUnit(0)
    setDraft(null)
    setResult(null)
    setShowBriefs(false)
    setMessage({ type: data.warnings.length ? 'warning' : 'success', title: 'Unit outline extracted', detail: data.warnings.join(' ') || 'Review the extracted information before generating the draft.' })
    setActiveStep('unit-information')
  })

  const createDraft = () => run('Generating draft schedule', async () => {
    if (!combinedUnit || sessionsPerWeek < 1 || sessionsPerWeek > 10) throw new Error('Enter a sessions-per-week value from 1 to 10.')
    const data = await generateDraft({ unit_info: combinedUnit, units: preparedUnits, sessions_per_week: sessionsPerWeek })
    setDraft(data)
    setResult(null)
    setActiveStep('extracted-assessments')
  })

  const createDetailed = () => run('Processing assessment briefs', async () => {
    if (!combinedUnit || !briefFiles.length) throw new Error('Upload at least one assessment brief.')
    const form = new FormData()
    briefFiles.forEach((file) => form.append('files', file))
    form.append('unit_info', JSON.stringify(combinedUnit))
    form.append('units', JSON.stringify(preparedUnits))
    form.append('existing_items', JSON.stringify(draft?.items ?? []))
    form.append('sessions_per_week', String(sessionsPerWeek))
    form.append('extraction_method', extractionMethod)
    form.append('require_ollama_scaffolding', 'true')
    form.append('ollama_host', ollamaHost)
    form.append('ollama_model', ollamaModel)
    const data = retainReviewedSchedule(await generateSchedule(form), draft)
    setResult(data)
    setSaved('')
    setMessage({ type: data.warnings?.length ? 'warning' : 'success', title: 'Detailed schedule generated', detail: data.warnings?.join(' ') || 'Steps 5 and 6 are ready.' })
    setActiveStep('learning-sequence')
  })

  const updateItem = (index: number, patch: Partial<AssessmentItem>) => {
    if (!displayResult) return
    const items = displayResult.items.map((item, itemIndex) => {
      if (itemIndex !== index) return item
      const next = { ...item, ...patch }
      if ('due_session' in patch) next.due_week = Math.ceil(Number(next.due_session || 0) / Math.max(sessionsPerWeek, 1))
      return next
    })
    const next = { ...displayResult, items }
    if (result) setResult(next); else setDraft(next)
    setSaved('')
  }

  const analysisPayload = () => ({
    items: displayResult?.items ?? [], unit_info: combinedUnit,
    extraction_method: extractionMethod, ollama_host: ollamaHost, ollama_model: ollamaModel,
    require_ollama_scaffolding: Boolean(result),
  })

  const validate = () => run('Validating schedule', async () => {
    const data = await analyseSchedule(analysisPayload())
    if (result) setResult(data); else setDraft(data)
    setMessage({ type: 'success', title: 'Validation complete', detail: 'The latest edits have been checked.' })
  })

  const optimise = () => run('Optimising schedule', async () => {
    const data = await optimiseSchedule(analysisPayload())
    setResult(data)
    setChanges(data.changes ?? [])
    setSaved('')
    setMessage({ type: 'success', title: 'Draft optimised', detail: (data.changes ?? []).join(' ') })
  })

  const persist = () => run('Saving schedule', async () => {
    if (!displayResult || !combinedUnit) return
    const data = await saveSchedule({
      name: `${combinedUnit.unit_code || 'Assessment'} schedule`,
      course_duration: displayResult.course_duration,
      unit_info: combinedUnit,
      units: preparedUnits,
      items: displayResult.items,
      schedule: displayResult.schedule,
    })
    setSaved(`Saved ${new Date(data.created_at).toLocaleString()} · ${data.id}`)
    setMessage({ type: 'success', title: 'Schedule saved', detail: `PostgreSQL snapshot ${data.id} was created.` })
  })

  const exportXml = () => run('Exporting XML', async () => {
    if (!displayResult || !combinedUnit) return
    const { blob, filename } = await exportScheduleXml({
      name: `${combinedUnit.unit_code || 'Assessment'} schedule`,
      course_duration: displayResult.course_duration,
      unit_info: combinedUnit,
      units: preparedUnits,
      items: displayResult.items,
      schedule: displayResult.schedule,
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    setMessage({ type: 'success', title: 'XML exported', detail: `${filename} was downloaded.` })
  })

  const toggleTheme = () => {
    setDark((value) => {
      document.documentElement.classList.toggle('dark', !value)
      return !value
    })
  }

  const progress = result ? 75 : draft ? 45 : units.length ? 25 : 8

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background">
        <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
          <div className="flex h-16 items-center gap-3 px-4 lg:px-6">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"><BookOpen className="size-5" /></div>
            <div className="min-w-0"><div className="truncate text-sm font-semibold sm:text-base">IQTERRA Assessment Scheduler</div><div className="hidden text-xs text-muted-foreground sm:block">Curriculum-aligned assessment planning</div></div>
            <div className="ml-auto flex items-center gap-2">
              {busy ? <Badge variant="secondary"><LoaderCircle className="animate-spin" />{busy}</Badge> : <Badge variant="outline"><span className="size-1.5 rounded-full bg-emerald-500" />Ready</Badge>}
              <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="Toggle colour theme">{dark ? <Sun /> : <Moon />}</Button>
            </div>
          </div>
          <Progress value={progress} className="h-0.5 rounded-none" />
          <nav aria-label="Workflow steps" className="border-t bg-card/95 px-3 py-2 sm:px-5">
            <ScrollArea className="w-full whitespace-nowrap">
              <div className="mx-auto flex w-max min-w-full max-w-[1600px] items-center gap-1">
                {sections.map(([id, number, label], index) => {
                  const available = isStepAvailable(id)
                  const active = activeStep === id
                  return (
                    <Button
                      key={id}
                      type="button"
                      variant={active ? 'default' : 'ghost'}
                      size="sm"
                      disabled={!available}
                      aria-current={active ? 'step' : undefined}
                      onClick={() => goToStep(id)}
                      className={`gap-2 px-3 ${active ? 'shadow-sm' : 'text-muted-foreground'}`}
                    >
                      <span className={`flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-[10px] font-semibold ${active ? 'bg-primary-foreground/20' : 'bg-muted'}`}>{number}</span>
                      <span>{label}</span>
                      {index < sections.length - 1 && <ChevronRight className="size-3 opacity-40" />}
                    </Button>
                  )
                })}
              </div>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          </nav>
        </header>

        <div className="mx-auto max-w-[1680px]">
          <main className="min-w-0 space-y-4 p-4 sm:p-5 lg:p-6">
            {message && <Alert variant={message.type === 'error' ? 'destructive' : 'default'} className={message.type === 'success' ? 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20' : ''}>{message.type === 'error' ? <AlertCircle /> : <CheckCircle2 />}<AlertTitle>{message.title}</AlertTitle><AlertDescription>{message.detail}</AlertDescription></Alert>}

            {activeStep === 'unit-upload' && <Section id="unit-upload" step="1" title="Set up the unit outlines" description="Upload the source documents and define the weekly teaching pace before extracting the unit information.">
              <div className="mb-6 grid gap-4 rounded-xl border bg-muted/20 p-4 md:grid-cols-3">
                <div className="space-y-2"><Label>Extraction method</Label><Select value={extractionMethod} onValueChange={setExtractionMethod}><SelectTrigger className="bg-card"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="rule-based">Rule-based</SelectItem><SelectItem value="ollama">Ollama + Gemma 4</SelectItem></SelectContent></Select></div>
                <div className="space-y-2"><Label htmlFor="ollama-host">Ollama host</Label><Input id="ollama-host" disabled={extractionMethod !== 'ollama'} value={ollamaHost} onChange={(event) => setOllamaHost(event.target.value)} /></div>
                <div className="space-y-2"><Label htmlFor="ollama-model">Model</Label><Input id="ollama-model" disabled={extractionMethod !== 'ollama'} value={ollamaModel} onChange={(event) => setOllamaModel(event.target.value)} /></div>
              </div>
              <div className="mb-4 flex items-start gap-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">1</span>
                <div><h3 className="font-semibold">Upload unit outlines</h3><p className="text-sm text-muted-foreground">Upload one or more PDF or DOCX files. Outlines with the same unit code are combined automatically.</p></div>
              </div>
              <FileDrop files={unitFiles} onFiles={setUnitFiles} label="Drop unit outlines here" hint="PDF or DOCX · click to browse" />
              <Separator className="my-6" />
              <div className="mb-4 flex items-start gap-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">2</span>
                <div><h3 className="font-semibold">Set sessions per week</h3><p className="text-sm text-muted-foreground">Enter how many teaching sessions are delivered each week. This will convert due sessions into weekly schedule positions.</p></div>
              </div>
              <div className="grid items-end gap-4 sm:grid-cols-[240px_1fr_auto]">
                <div className="space-y-2"><Label htmlFor="sessions-per-week">Sessions per week</Label><Input id="sessions-per-week" type="number" min={1} max={10} value={sessionsPerWeek || ''} onChange={(event) => { setSessionsPerWeek(Number(event.target.value)); setDraft(null); setResult(null) }} placeholder="e.g. 3" /></div>
                <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm">{units.length && sessionsPerWeek > 0 ? <><span className="font-semibold">{totalSessions} sessions</span> at <span className="font-semibold">{sessionsPerWeek} per week</span> creates a <span className="font-semibold">{calculatedWeeks}-week schedule</span>.</> : 'The total schedule length will be calculated after the sessions are extracted.'}</div>
                <Button disabled={!unitFiles.length || sessionsPerWeek < 1 || sessionsPerWeek > 10 || !!busy} onClick={extract}>{busy === 'Extracting unit information' ? <LoaderCircle className="animate-spin" /> : <Sparkles />}Extract unit information</Button>
              </div>
            </Section>}

            {activeStep === 'unit-information' && currentUnit && <Section id="unit-information" step="2" title="Review extracted unit information" description="Confirm the unit details, assessment information, and session-by-session teaching plan before scheduling." action={units.length > 1 ? <Tabs value={String(activeUnit)} onValueChange={(value) => setActiveUnit(Number(value))}><TabsList className="bg-primary/10">{units.map((unit, index) => <TabsTrigger className="px-3 hover:bg-primary/10 hover:text-primary data-active:border-primary data-active:bg-primary data-active:text-primary-foreground dark:data-active:bg-primary dark:data-active:text-primary-foreground" key={`${unit.unit_code}-${index}`} value={String(index)}>{unit.unit_code || `Unit ${index + 1}`}</TabsTrigger>)}</TabsList></Tabs> : undefined}>
              <Tabs defaultValue="unit-details" className="w-full">
                <TabsList className="grid h-auto w-full grid-cols-1 bg-primary/10 sm:grid-cols-3">
                  <TabsTrigger className="hover:bg-primary/10 hover:text-primary data-active:border-primary data-active:bg-primary data-active:text-primary-foreground dark:data-active:bg-primary dark:data-active:text-primary-foreground" value="unit-details">Unit information</TabsTrigger>
                  <TabsTrigger className="hover:bg-primary/10 hover:text-primary data-active:border-primary data-active:bg-primary data-active:text-primary-foreground dark:data-active:bg-primary dark:data-active:text-primary-foreground" value="assessment-information">Assessment information</TabsTrigger>
                  <TabsTrigger className="hover:bg-primary/10 hover:text-primary data-active:border-primary data-active:bg-primary data-active:text-primary-foreground dark:data-active:bg-primary dark:data-active:text-primary-foreground" value="teaching-sessions">Teaching sessions</TabsTrigger>
                </TabsList>

                <TabsContent value="unit-details" className="mt-6">
                  <div className="grid gap-5 md:grid-cols-3">
                    <div className="space-y-2"><Label>Unit code</Label><Input value={currentUnit.unit_code} onChange={(event) => updateCurrentUnit({ unit_code: event.target.value })} /></div>
                    <div className="space-y-2 md:col-span-2"><Label>Unit name</Label><Input value={currentUnit.unit_name} onChange={(event) => updateCurrentUnit({ unit_name: event.target.value })} /></div>
                    <div className="space-y-2"><Label>Number of sessions</Label><Input readOnly value={currentUnit.sessions.length} /></div>
                    <div className="space-y-2 md:col-span-2">
                      <div className="flex items-center justify-between"><Label>Learning outcomes</Label><Button variant="outline" size="sm" onClick={() => updateCurrentUnit({ learning_outcomes: [...currentUnit.learning_outcomes, ''] })}><Plus />Add outcome</Button></div>
                      <ScrollArea className="h-[340px] rounded-lg border bg-card">
                        <div className="space-y-2 p-3">
                          {currentUnit.learning_outcomes.map((outcome, index) => (
                            <div key={index} className="grid grid-cols-[32px_1fr_32px] items-start gap-2 rounded-lg border bg-background p-2">
                              <span className="flex size-7 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground">{index + 1}</span>
                              <Textarea aria-label={`Learning outcome ${index + 1}`} rows={2} className="min-h-14 resize-none" value={outcome} onChange={(event) => updateCurrentUnit({ learning_outcomes: currentUnit.learning_outcomes.map((item, itemIndex) => itemIndex === index ? event.target.value : item) })} />
                              <Button variant="ghost" size="icon-sm" aria-label={`Remove learning outcome ${index + 1}`} onClick={() => updateCurrentUnit({ learning_outcomes: currentUnit.learning_outcomes.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 /></Button>
                            </div>
                          ))}
                          {!currentUnit.learning_outcomes.length && <div className="flex h-28 items-center justify-center text-sm text-muted-foreground">No learning outcomes were extracted.</div>}
                        </div>
                      </ScrollArea>
                    </div>
                  </div>
                </TabsContent>

                <TabsContent value="assessment-information" className="mt-6">
                  <div className="mb-4 flex items-center justify-between"><div><h3 className="font-semibold">Assessment information</h3><p className="text-sm text-muted-foreground">Information already available in the unit outline.</p></div><Button variant="outline" size="sm" onClick={() => updateCurrentUnit({ assessment_information: [...currentUnit.assessment_information, ''] })}><Plus />Add assessment</Button></div>
                  <div className="hidden grid-cols-[170px_1fr_160px_40px] gap-2 px-1 text-xs font-medium text-muted-foreground sm:grid"><span>Assessment</span><span>Information</span><span>Due after session</span><span /></div>
                  <div className="space-y-2">{currentUnit.assessment_information.map((value, index) => <div key={index} className="grid gap-2 sm:grid-cols-[170px_1fr_160px_40px]"><div className="flex items-center text-sm font-medium">{assessmentLabel(currentUnit.assessment_information, index)}</div><Input value={value} onChange={(event) => updateCurrentUnit({ assessment_information: currentUnit.assessment_information.map((item, itemIndex) => itemIndex === index ? event.target.value : item) })} /><Input aria-label={`Due session for ${assessmentLabel(currentUnit.assessment_information, index)}`} type="number" min={0} value={dueSessionFromText(value) || ''} onChange={(event) => updateCurrentUnit({ assessment_information: currentUnit.assessment_information.map((item, itemIndex) => itemIndex === index ? withDueSession(item, Number(event.target.value)) : item) })} /><Button variant="ghost" size="icon" onClick={() => updateCurrentUnit({ assessment_information: currentUnit.assessment_information.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 /></Button></div>)}</div>
                </TabsContent>

                <TabsContent value="teaching-sessions" className="mt-6">
                  <div className="mb-4 flex items-center justify-between"><div><h3 className="font-semibold">Teaching sessions</h3><p className="text-sm text-muted-foreground">Keep one topic per session; no weekly division is applied here.</p></div><Button variant="outline" size="sm" onClick={() => updateCurrentUnit({ sessions: [...currentUnit.sessions, { session: currentUnit.sessions.length + 1, topic: '' }] })}><Plus />Add session</Button></div>
                  <ScrollArea className="h-[286px] rounded-lg border bg-card">
                    <Table><TableHeader className="sticky top-0 z-10 bg-muted"><TableRow><TableHead className="w-28">Session</TableHead><TableHead>Topic</TableHead><TableHead className="w-14" /></TableRow></TableHeader><TableBody>{currentUnit.sessions.map((session, index) => <TableRow key={index}><TableCell className="font-medium">Session {index + 1}</TableCell><TableCell><Input value={session.topic} onChange={(event) => updateCurrentUnit({ sessions: currentUnit.sessions.map((item, itemIndex) => itemIndex === index ? { ...item, topic: event.target.value } : item) })} /></TableCell><TableCell><Button variant="ghost" size="icon" onClick={() => updateCurrentUnit({ sessions: currentUnit.sessions.filter((_, itemIndex) => itemIndex !== index).map((item, itemIndex) => ({ ...item, session: itemIndex + 1 })) })}><Trash2 /></Button></TableCell></TableRow>)}</TableBody></Table>
                  </ScrollArea>
                </TabsContent>
              </Tabs>

              <Separator className="my-6" />
              <div className="flex flex-col gap-4 rounded-xl border bg-muted/25 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div><p className="font-medium">Delivery pattern confirmed</p><p className="text-sm text-muted-foreground">{totalSessions} sessions at {sessionsPerWeek} per week creates a {calculatedWeeks}-week schedule.</p></div>
                <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => goToStep('assessment-upload')}>Add assessment briefs</Button><Button disabled={!!busy} onClick={createDraft}><Sparkles />Generate draft</Button></div>
              </div>
            </Section>}

            {activeStep === 'extracted-assessments' && draft && <Section id="extracted-assessments" step="4" title="Review the outline-only draft" description="Each independently due part is listed separately. Due weeks are derived from the selected due session." action={<Badge variant="secondary">Draft</Badge>}>
              <SubjectAssessmentTabs items={draft.items} onChange={updateItem} />
              <div className="mt-6 flex flex-col gap-3 rounded-xl border bg-muted/25 p-4 sm:flex-row sm:items-center sm:justify-between"><p className="text-sm text-muted-foreground">Continue to add richer assessment requirements, learning outcomes, and workload details from the briefs.</p><Button onClick={() => goToStep('assessment-upload')}>Add assessment briefs<ArrowRight /></Button></div>
            </Section>}

            {activeStep === 'assessment-upload' && currentUnit && showBriefs && <Section id="assessment-upload" step="Before Step 5" title="Upload additional assessment briefs" description="Add PDF or DOCX briefs to generate the topic coverage evaluation and detailed weekly schedule." action={<Button disabled={!briefFiles.length || !!busy} onClick={createDetailed}>{busy === 'Processing assessment briefs' ? <LoaderCircle className="animate-spin" /> : <Sparkles />}Generate Steps 5 and 6</Button>}>
              <FileDrop files={briefFiles} onFiles={setBriefFiles} label="Drop assessment briefs here" hint="PDF or DOCX · click to browse" />
            </Section>}

            {activeStep === 'learning-sequence' && result && <Section id="learning-sequence" step="5" title="Evaluate required topic coverage" description="Check whether required knowledge and skills are taught on or before each assessment deadline." action={<Badge variant="outline">{result.scaffolding_source === 'ollama' ? result.scaffolding_model : 'Rule-based'}</Badge>}>
              <CoverageEvaluation items={result.items} evaluations={result.scaffolding} />
            </Section>}

            {activeStep === 'weekly-schedule' && result && <Section id="weekly-schedule" step="6" title="Draft course schedule" description="The weekly matrix places each assessment in the week containing its due session. Assessments default to Individual unless explicitly marked Group." action={<div className="flex flex-wrap items-center gap-2"><span className="max-w-72 truncate text-xs text-muted-foreground">{saved}</span><Button variant="outline" size="sm" onClick={exportXml} disabled={!!busy}><Download />Export XML</Button><Button variant="outline" size="sm" onClick={persist} disabled={!!busy}><Database />Save to PostgreSQL</Button></div>}>
              <SubjectAssessmentTabs items={result.items} onChange={updateItem} />
              <div className="mt-4 flex items-center gap-3 rounded-lg border bg-primary/5 p-3 text-sm"><CalendarDays className="size-5 shrink-0 text-primary" /><span>The weekly schedule updates automatically and is available from the orange button at the bottom-right of the screen.</span></div>
            </Section>}

            {activeStep === 'validation' && result && <Section id="validation" step="7" title="Validate schedule" description="Review weighting, workload concentration, course bounds, and preparation timing." action={<Button variant="outline" onClick={validate} disabled={!!busy}><ClipboardCheck />Run validation</Button>}>
              <div className="grid gap-3 md:grid-cols-2">{result.feedback.map((item, index) => <Alert key={`${item.title}-${index}`} variant={item.severity === 'error' ? 'destructive' : 'default'} className={item.severity === 'success' ? 'border-emerald-300' : ''}>{item.severity === 'error' ? <AlertCircle /> : <CheckCircle2 />}<AlertTitle>{item.title}</AlertTitle><AlertDescription>{item.message}</AlertDescription></Alert>)}</div>
            </Section>}

            {activeStep === 'optimization' && result && <Section id="optimization" step="8" title="Optimise schedule" description="Move assessments away from unavailable or overloaded weeks while preserving the draft for review." action={<Button onClick={optimise} disabled={!!busy}><RefreshCw />Optimise draft</Button>}>
              {changes.length ? <div className="space-y-2">{changes.map((change, index) => <div key={index} className="flex gap-3 rounded-lg border p-3 text-sm"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />{change}</div>)}</div> : <p className="text-sm text-muted-foreground">No optimisation has been run.</p>}
            </Section>}

            {activeStep === 'academic-review' && result && <Section id="academic-review" step="9" title="Human / academic review" description="Record the reviewer decision and comments before publication.">
              <div className="grid gap-4 md:grid-cols-2"><div className="space-y-2"><Label>Reviewer</Label><Input value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="Academic reviewer name" /></div><div className="space-y-2"><Label>Decision</Label><Select value={decision} onValueChange={(value) => { setDecision(value); setPublished(false) }}><SelectTrigger><SelectValue placeholder="Select decision" /></SelectTrigger><SelectContent><SelectItem value="approved">Approved</SelectItem><SelectItem value="changes">Changes required</SelectItem></SelectContent></Select></div><div className="space-y-2 md:col-span-2"><Label>Review comments</Label><Textarea rows={5} value={comments} onChange={(event) => setComments(event.target.value)} placeholder="Add approval notes or required changes" /></div></div>
            </Section>}

            {activeStep === 'publish' && result && <Section id="publish" step="10" title="Publish final course schedule" description="Finalise the approved schedule for distribution." action={<Badge variant={published ? 'default' : decision === 'approved' ? 'secondary' : 'outline'}>{published ? 'Published' : decision === 'approved' ? 'Ready to publish' : 'Awaiting approval'}</Badge>}>
              <div className="flex flex-col gap-4 rounded-xl border bg-muted/25 p-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium">{decision === 'approved' ? `Approved by ${reviewer || 'academic reviewer'}.` : 'Academic approval is required before publication.'}</p>{comments && <p className="mt-1 text-sm text-muted-foreground">{comments}</p>}</div><div className="flex gap-2"><Button variant="outline" disabled={decision !== 'approved'} onClick={() => window.print()}><Printer />Print</Button><Button disabled={decision !== 'approved'} onClick={() => setPublished(true)}><Save />Publish schedule</Button></div></div>
            </Section>}

            <div className="flex items-center justify-between rounded-xl border bg-card px-3 py-2 shadow-sm">
              <Button variant="outline" onClick={() => moveStep(-1)} disabled={!hasPreviousStep}><ChevronLeft />Previous</Button>
              <div className="text-center"><p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Workflow navigation</p><p className="text-sm font-semibold">{sections[activeStepIndex]?.[2]}</p></div>
              <Button onClick={() => moveStep(1)} disabled={!hasNextStep}>Next<ChevronRight /></Button>
            </div>
          </main>
        </div>

        <Dialog>
          <DialogTrigger asChild>
            <Button className="fixed right-4 bottom-4 z-50 h-12 rounded-full px-5 shadow-xl shadow-primary/20 sm:right-6 sm:bottom-6 print:hidden">
              <CalendarDays />Weekly schedule
            </Button>
          </DialogTrigger>
          <DialogContent className="flex h-[92vh] !max-w-[96vw] flex-col overflow-hidden sm:!max-w-[96vw]">
            <DialogHeader>
              <DialogTitle>Weekly assessment schedule</DialogTitle>
              <DialogDescription>{displayResult ? (result ? 'Coverage from Step 5 is shown here: green is covered, orange is partially covered or needs review, and red is not covered.' : 'Red assessments use information from the unit outline because no assessment brief has been provided yet.') : 'Generate an outline draft to populate the weekly schedule.'}</DialogDescription>
            </DialogHeader>
            {displayResult && <div className="flex justify-end"><Button variant="outline" size="sm" onClick={exportXml} disabled={!!busy}><Download />Export XML</Button></div>}
            <div className="min-h-0 flex-1 overflow-auto">
              {displayResult
                ? <ScheduleMatrix items={displayResult.items} weeks={displayResult.course_duration} outlineOnly={!result} coverageEvaluations={result?.scaffolding} />
                : <div className="flex h-full min-h-64 flex-col items-center justify-center rounded-xl border border-dashed bg-muted/20 p-8 text-center"><CalendarDays className="mb-3 size-9 text-muted-foreground" /><p className="font-medium">No schedule generated yet</p><p className="mt-1 text-sm text-muted-foreground">Complete Steps 1 and 2, then generate the outline draft.</p></div>}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  )
}

function CoverageEvaluation({ items, evaluations }: { items: AssessmentItem[]; evaluations: ScaffoldingItem[] }) {
  const [assessmentFilter, setAssessmentFilter] = useState('all')
  const [assessmentSearch, setAssessmentSearch] = useState('')

  const rows = evaluations.map((evaluation, index) => {
    const item = items[index]
    const component = evaluation.component && !/^(whole assessment|assessment)$/i.test(evaluation.component) ? evaluation.component : ''
    const title = `${evaluation.assessment_name}${component ? ` — ${component}` : ''}`
    const assessmentGroup = evaluation.assessment_name.match(/\bAssessment\s*\d+/i)?.[0] ?? evaluation.assessment_name
    const requirements = evaluation.requirement_coverage ?? []
    const total = requirements.length
    const covered = requirements.filter((requirement) => requirement.status === 'covered').length
    const percentage = total > 0 ? Math.round((covered / total) * 100) : 0
    const missing = requirements.filter((requirement) => requirement.status !== 'covered')
    const matchedFromRequirements = requirements
      .filter((requirement) => requirement.matched_week > 0 && requirement.matched_topic)
      .map((requirement) => ({
        week: requirement.matched_week,
        topic: requirement.matched_topic,
        requirement: requirement.requirement,
      }))
    const matched = matchedFromRequirements.length
      ? matchedFromRequirements
      : (evaluation.matched_topics ?? []).map((topic) => ({ ...topic, requirement: '' }))
    return {
      evaluation,
      item,
      originalIndex: index,
      title,
      assessmentGroup,
      filterKey: assessmentGroup.toLowerCase(),
      requirements,
      total,
      covered,
      percentage,
      missing,
      matched,
    }
  })

  const subjectOptions = Array.from(rows.reduce((values, row) => {
    const code = row.item?.subject_code || 'Unassigned'
    const key = code.trim().toLowerCase()
    if (!values.has(key)) values.set(key, { code, name: row.item?.subject_name || 'Unit not identified' })
    return values
  }, new Map<string, { code: string; name: string }>()).entries())
  const [subjectFilter, setSubjectFilter] = useState(subjectOptions[0]?.[0] ?? '')
  const activeSubject = subjectOptions.some(([key]) => key === subjectFilter) ? subjectFilter : (subjectOptions[0]?.[0] ?? '')
  const subjectRows = rows.filter((row) => (row.item?.subject_code || 'Unassigned').trim().toLowerCase() === activeSubject)
  const filterOptions = Array.from(new Map(subjectRows.map((row) => [row.filterKey, row.assessmentGroup])).entries())
  const search = assessmentSearch.trim().toLowerCase()
  const visibleRows = subjectRows.filter((row) => (
    (assessmentFilter === 'all' || row.filterKey === assessmentFilter)
    && (!search || row.title.toLowerCase().includes(search))
  ))

  return (
    <div className="space-y-5">
      {subjectOptions.length > 1 && (
        <Tabs value={activeSubject} onValueChange={(value) => { setSubjectFilter(value); setAssessmentFilter('all') }}>
          <TabsList className="h-auto max-w-full justify-start overflow-x-auto bg-primary/10">
            {subjectOptions.map(([key, subject]) => <TabsTrigger className="px-3 hover:bg-primary/10 hover:text-primary data-active:border-primary data-active:bg-primary data-active:text-primary-foreground dark:data-active:bg-primary dark:data-active:text-primary-foreground" key={key} value={key}>{subject.code}</TabsTrigger>)}
          </TabsList>
        </Tabs>
      )}
      <div className="grid gap-4 rounded-xl border bg-muted/20 p-4 md:grid-cols-[240px_1fr_auto] md:items-end">
        <div className="space-y-2">
          <Label>Assessment filter</Label>
          <Select value={assessmentFilter} onValueChange={setAssessmentFilter}>
            <SelectTrigger className="w-full bg-card"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Assessments</SelectItem>
              {filterOptions.map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="coverage-search">Search assessments</Label>
          <div className="relative"><Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" /><Input id="coverage-search" className="bg-card pl-8" value={assessmentSearch} onChange={(event) => setAssessmentSearch(event.target.value)} placeholder="Search by assessment title" /></div>
        </div>
        <p className="pb-1 text-sm text-muted-foreground">Showing <span className="font-semibold text-foreground">{visibleRows.length}</span> of {subjectRows.length} assessments</p>
      </div>

      {visibleRows.length ? (
        <Accordion type="single" collapsible className="space-y-3">
          {visibleRows.map((row) => {
            const deadline = row.item?.due_week > 0 ? `Week ${row.item.due_week}` : 'Due week required'
            const unitCode = row.item?.subject_code || 'Unit not identified'
            return (
              <AccordionItem key={`${row.title}-${row.originalIndex}`} value={`coverage-${row.originalIndex}`} className="overflow-hidden rounded-xl border bg-card px-4 shadow-xs data-[state=open]:border-primary/40">
                <AccordionTrigger className="py-4 hover:no-underline">
                  <div className="min-w-0 flex-1 space-y-3 pr-2">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0"><p className="break-words font-semibold text-foreground">{row.title}</p><p className="mt-1 text-xs font-normal text-muted-foreground">{unitCode} · {row.covered} of {row.total} requirements covered by {deadline}</p></div>
                      <Badge variant={row.evaluation.status === 'error' ? 'destructive' : 'outline'} className={row.evaluation.status === 'success' ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' : row.evaluation.status === 'warning' ? 'border-primary/30 bg-primary/10 text-primary' : ''}>{row.evaluation.label}</Badge>
                    </div>
                    <div className="flex items-center gap-3"><Progress value={row.percentage} className="h-2 flex-1" /><span className="w-10 text-right text-xs font-semibold text-foreground">{row.percentage}%</span></div>
                  </div>
                </AccordionTrigger>
                <AccordionContent>
                  <Separator />
                  <section className="py-5">
                    <h4 className="font-semibold">Coverage summary</h4>
                    <p className="mt-1 text-sm text-muted-foreground">{row.evaluation.rationale}</p>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <div className="rounded-lg border bg-muted/20 p-3"><p className="text-xs text-muted-foreground">Requirements covered</p><p className="mt-1 text-lg font-semibold">{row.covered} of {row.total}</p></div>
                      <div className="rounded-lg border bg-muted/20 p-3"><p className="text-xs text-muted-foreground">Coverage</p><p className="mt-1 text-lg font-semibold">{row.percentage}%</p></div>
                      <div className="rounded-lg border bg-muted/20 p-3"><p className="text-xs text-muted-foreground">Assessment deadline</p><p className="mt-1 text-lg font-semibold">{deadline}</p></div>
                      <div className="rounded-lg border bg-muted/20 p-3"><p className="text-xs text-muted-foreground">Coverage status</p><p className="mt-1 text-sm font-semibold">{row.evaluation.label}</p></div>
                    </div>
                    <div className="mt-4 flex items-center gap-3"><Progress value={row.percentage} className="h-2 flex-1" /><span className="text-sm font-semibold">{row.percentage}%</span></div>
                  </section>

                  <Separator />
                  <section className="py-5">
                    <h4 className="font-semibold">Missing topic coverage</h4>
                    <p className="mt-1 text-sm text-muted-foreground">Requirements that are not covered by a suitable topic on or before the deadline.</p>
                    {row.missing.length ? <div className="mt-4 space-y-2">{row.missing.map((requirement, index) => <div key={`${requirement.requirement}-${index}`} className="flex items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3"><AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" /><div className="min-w-0"><p className="break-words font-medium">{requirement.requirement}</p><p className="mt-1 break-words text-xs text-muted-foreground">{requirement.detail}</p></div><Badge variant="outline" className="ml-auto shrink-0 text-destructive">{requirement.status.replaceAll('_', ' ')}</Badge></div>)}</div> : <div className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"><CheckCircle2 className="size-4" />All required topics are covered.</div>}
                  </section>

                  <Separator />
                  <section className="pt-5">
                    <h4 className="font-semibold">Matched teaching sessions</h4>
                    <p className="mt-1 text-sm text-muted-foreground">Teaching topics matched by the existing coverage evaluation.</p>
                    {row.matched.length ? <div className="mt-4 space-y-2">{row.matched.map((match, index) => <div key={`${match.week}-${match.topic}-${index}`} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-start"><div className="flex shrink-0 gap-2"><Badge>Week {match.week}</Badge><Badge variant="outline">{unitCode}</Badge></div><div className="min-w-0"><p className="break-words font-medium leading-relaxed">{match.topic}</p>{match.requirement && <p className="mt-1 break-words text-xs text-muted-foreground">Requirement: {match.requirement}</p>}</div></div>)}</div> : <div className="mt-4 rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No matched teaching sessions were found.</div>}
                  </section>
                </AccordionContent>
              </AccordionItem>
            )
          })}
        </Accordion>
      ) : <div className="rounded-xl border border-dashed bg-muted/10 p-10 text-center"><Search className="mx-auto mb-3 size-8 text-muted-foreground" /><p className="font-medium">No assessments match these filters</p><p className="mt-1 text-sm text-muted-foreground">Try another assessment filter or search term.</p></div>}
    </div>
  )
}

function SubjectAssessmentTabs({ items, onChange }: { items: AssessmentItem[]; onChange: (index: number, patch: Partial<AssessmentItem>) => void }) {
  const subjects = Array.from(items.reduce((values, item) => {
    const key = (item.subject_code || 'Unassigned').trim().toLowerCase()
    if (!values.has(key)) values.set(key, { code: item.subject_code || 'Unassigned', name: item.subject_name || 'Unit not identified' })
    return values
  }, new Map<string, { code: string; name: string }>()).entries())

  if (subjects.length <= 1) return <AssessmentEditor items={items} onChange={onChange} scrollArea />

  return (
    <Tabs defaultValue={subjects[0][0]} className="w-full">
      <TabsList className="h-auto max-w-full justify-start overflow-x-auto bg-primary/10">
        {subjects.map(([key, subject]) => <TabsTrigger className="px-3 hover:bg-primary/10 hover:text-primary data-active:border-primary data-active:bg-primary data-active:text-primary-foreground dark:data-active:bg-primary dark:data-active:text-primary-foreground" key={key} value={key}>{subject.code}</TabsTrigger>)}
      </TabsList>
      {subjects.map(([key, subject]) => {
        const subjectItems = items.map((item, index) => ({ item, index })).filter(({ item }) => (item.subject_code || 'Unassigned').trim().toLowerCase() === key)
        return (
          <TabsContent key={key} value={key} className="mt-4">
            <div className="mb-3"><p className="font-medium">{subject.code}</p><p className="text-sm text-muted-foreground">{subject.name}</p></div>
            <AssessmentEditor items={subjectItems.map(({ item }) => item)} onChange={(index, patch) => onChange(subjectItems[index].index, patch)} scrollArea />
          </TabsContent>
        )
      })}
    </Tabs>
  )
}

function AssessmentEditor({ items, onChange, scrollArea = false }: { items: AssessmentItem[]; onChange: (index: number, patch: Partial<AssessmentItem>) => void; scrollArea?: boolean }) {
  const totals = new Map<string, number>()
  const seen = new Map<string, number>()
  items.forEach((item) => { const key = `${item.subject_code}|${item.assessment_name}`.toLowerCase(); totals.set(key, (totals.get(key) ?? 0) + 1) })
  const table = <Table><TableHeader className={scrollArea ? 'sticky top-0 z-10 bg-muted' : ''}><TableRow><TableHead>Assessment</TableHead><TableHead className="min-w-36">Type</TableHead><TableHead className="w-28">Weight %</TableHead><TableHead className="w-40">Due after session</TableHead></TableRow></TableHeader><TableBody>{items.map((item, index) => {
      const key = `${item.subject_code}|${item.assessment_name}`.toLowerCase()
      const count = (seen.get(key) ?? 0) + 1
      seen.set(key, count)
      const explicit = item.component && !/^(whole assessment|assessment)$/i.test(item.component)
      const part = explicit ? item.component : (totals.get(key) ?? 0) > 1 ? `Part ${String.fromCharCode(64 + count)}` : ''
      return <TableRow key={`${key}-${index}`}><TableCell><div className="font-medium">{item.assessment_name}{part ? ` — ${part}` : ''}</div><div className="text-xs text-muted-foreground">{item.subject_code || 'Unit not identified'}</div></TableCell><TableCell><Select value={/\bgroup\b/i.test(item.assessment_type) ? 'Group' : 'Individual'} onValueChange={(value) => onChange(index, { assessment_type: value })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="Individual">Individual</SelectItem><SelectItem value="Group">Group</SelectItem></SelectContent></Select></TableCell><TableCell><Input type="number" min={0} max={100} value={item.weight} onChange={(event) => onChange(index, { weight: Number(event.target.value) })} /></TableCell><TableCell><Input type="number" min={0} value={item.due_session || ''} onChange={(event) => onChange(index, { due_session: Number(event.target.value) })} /></TableCell></TableRow>
    })}</TableBody></Table>
  return scrollArea
    ? <ScrollArea className="h-[286px] rounded-lg border bg-card">{table}</ScrollArea>
    : <div className="overflow-hidden rounded-lg border">{table}</div>
}

export default App
