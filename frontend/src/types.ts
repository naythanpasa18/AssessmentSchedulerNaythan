export type Session = {
  session: number
  topic: string
  source_week?: string
}

export type WeeklyTopic = {
  week: string
  topic: string
}

export type UnitInfo = {
  unit_code: string
  unit_name: string
  teaching_weeks: number
  course_duration: number
  learning_outcomes: string[]
  assessment_information: string[]
  weekly_topics: WeeklyTopic[]
  sessions: Session[]
  prerequisite_concepts: string[]
  teaching_activities: string[]
  breaks: string[]
  scheduling_constraints: string[]
  source_file: string
}

export type AssessmentItem = {
  subject_code: string
  subject_name: string
  assessment_name: string
  component: string
  assessment_type: string
  weight: number
  due_week: number
  due_session: number
  source_file: string
  raw_due_text: string
  learning_outcomes_assessed: string[]
  required_topics_skills: string[]
  estimated_workload_hours: number
  preparation_weeks: number
  dependencies: string[]
  feedback_requirements: string[]
}

export type WeekRow = {
  Week: number
  'Assessments due': string
  'Weight due': number
}

export type FeedbackItem = {
  severity: 'success' | 'warning' | 'error'
  title: string
  message: string
  subject_code?: string
}

export type ScaffoldingItem = {
  assessment_name: string
  component: string
  status: string
  label: string
  rationale: string
  topic_readiness: string
  matched_topics: Array<{ week: number; topic: string }>
  requirement_coverage: Array<{
    requirement: string
    status: string
    matched_week: number
    matched_topic: string
    detail: string
  }>
}

export type ScheduleResult = {
  items: AssessmentItem[]
  schedule: WeekRow[]
  feedback: FeedbackItem[]
  scaffolding: ScaffoldingItem[]
  scaffolding_source: string
  scaffolding_model: string
  course_duration: number
  warnings?: string[]
  errors?: string[]
  changes?: string[]
}

export type ExtractUnitResponse = {
  unit: UnitInfo
  units: UnitInfo[]
  warnings: string[]
}
