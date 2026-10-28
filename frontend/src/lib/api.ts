import type { ExtractUnitResponse, ScheduleResult } from '@/types'

export async function apiResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  let data: unknown = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`The server returned an unexpected response (${response.status}).`)
  }
  if (!response.ok) {
    const value = data as { error?: string; details?: string[] }
    throw new Error([value.error, ...(value.details ?? [])].filter(Boolean).join(' ') || `Request failed (${response.status}).`)
  }
  return data as T
}

export async function extractUnits(formData: FormData) {
  return apiResponse<ExtractUnitResponse>(await fetch('/api/unit-outline', { method: 'POST', body: formData }))
}

export async function generateDraft(payload: object) {
  return apiResponse<ScheduleResult>(await fetch('/api/unit-draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }))
}

export async function generateSchedule(formData: FormData) {
  return apiResponse<ScheduleResult>(await fetch('/api/generate', { method: 'POST', body: formData }))
}

export async function analyseSchedule(payload: object) {
  return apiResponse<ScheduleResult>(await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }))
}

export async function optimiseSchedule(payload: object) {
  return apiResponse<ScheduleResult>(await fetch('/api/optimize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }))
}

export async function saveSchedule(payload: object) {
  return apiResponse<{ id: string; name: string; created_at: string }>(await fetch('/api/schedules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }))
}
