<script setup lang="ts">
import { onMounted, ref } from 'vue'
import CollapsibleSection from '@/components/CollapsibleSection.vue'
import { api } from '@/lib/api'

type Permission = {
  key: string
  category: string
  description: string
  nonDelegable: boolean
}

type FarmRole = {
  id: string
  name: string
  isSystem: boolean
  clonedFrom: string | null
  permissions: string[]
  permissionsVersion: number
}

const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
const message = ref<string | null>(null)
const catalog = ref<Permission[]>([])
const roles = ref<FarmRole[]>([])
const selectedId = ref<string | null>(null)
const draft = ref<Set<string>>(new Set())
const newRoleName = ref('')

const selected = () => roles.value.find((r) => r.id === selectedId.value) ?? null

async function load() {
  loading.value = true
  error.value = null
  try {
    const [cat, list] = await Promise.all([
      api<{ permissions: Permission[] }>('/api/roles/catalog'),
      api<{ roles: FarmRole[] }>('/api/roles'),
    ])
    catalog.value = cat.permissions
    roles.value = list.roles
    if (!selectedId.value && list.roles.length) {
      selectRole(list.roles.find((r) => r.clonedFrom === 'supervisor')?.id ?? list.roles[0]!.id)
    } else if (selectedId.value) {
      selectRole(selectedId.value)
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load roles'
  } finally {
    loading.value = false
  }
}

function selectRole(id: string) {
  selectedId.value = id
  const role = roles.value.find((r) => r.id === id)
  draft.value = new Set(role?.permissions ?? [])
  message.value = null
}

function toggle(key: string, nonDelegable: boolean) {
  if (nonDelegable) return
  const role = selected()
  if (!role || role.clonedFrom === 'owner') return
  if (draft.value.has(key)) draft.value.delete(key)
  else draft.value.add(key)
  draft.value = new Set(draft.value)
}

async function save() {
  const role = selected()
  if (!role || role.clonedFrom === 'owner') return
  saving.value = true
  message.value = null
  try {
    const data = await api<{ roles: FarmRole[]; revokedUsers: number }>(
      `/api/roles/${role.id}/permissions`,
      {
        method: 'PATCH',
        body: JSON.stringify({ permissions: [...draft.value] }),
      },
    )
    roles.value = data.roles
    selectRole(role.id)
    message.value = `Saved. ${data.revokedUsers} user session(s) revoked.`
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Save failed'
  } finally {
    saving.value = false
  }
}

async function createRole() {
  const name = newRoleName.value.trim()
  if (!name) return
  saving.value = true
  try {
    const cloneFrom = selected()?.id
    const data = await api<{ roles: FarmRole[]; role?: FarmRole }>('/api/roles', {
      method: 'POST',
      body: JSON.stringify({ name, cloneFromRoleId: cloneFrom }),
    })
    roles.value = data.roles
    newRoleName.value = ''
    if (data.role) selectRole(data.role.id)
    message.value = 'Role created'
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Create failed'
  } finally {
    saving.value = false
  }
}

onMounted(load)

const categories = () => {
  const map = new Map<string, Permission[]>()
  for (const p of catalog.value) {
    if (p.nonDelegable) continue
    const list = map.get(p.category) ?? []
    list.push(p)
    map.set(p.category, list)
  }
  return [...map.entries()]
}
</script>

<template>
  <CollapsibleSection
    class="mt-6"
    title="Roles & permissions"
    description="Edit role access only when responsibilities change. Admin always has full access, and saved changes revoke affected sessions."
    :default-open="false"
    test-id="settings-roles-section"
  >
    <p v-if="loading" class="text-xs text-slate-400 mt-4">Loading…</p>
    <p v-else-if="error" class="text-xs text-red-400 mt-4">{{ error }}</p>

    <div v-else class="mt-4 grid gap-4 lg:grid-cols-[220px_1fr]">
      <div class="space-y-2">
        <button
          v-for="role in roles"
          :key="role.id"
          type="button"
          class="w-full text-left text-xs px-3 py-2 rounded-lg border"
          :class="
            selectedId === role.id
              ? 'border-farm-green bg-farm-green/10 text-farm-green'
              : 'border-slate-800 text-slate-300 hover:bg-slate-800'
          "
          @click="selectRole(role.id)"
        >
          <span class="font-semibold">{{ role.name }}</span>
          <span v-if="role.isSystem" class="ml-1 text-slate-500">(system)</span>
        </button>
        <div class="pt-2 border-t border-slate-800 space-y-2">
          <input
            v-model="newRoleName"
            aria-label="New role name"
            type="text"
            maxlength="80"
            placeholder="New role name"
            class="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white"
          />
          <button
            type="button"
            class="w-full text-xs font-bold px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:opacity-50"
            :disabled="saving || !newRoleName.trim()"
            @click="createRole"
          >
            Clone selected → new role
          </button>
        </div>
      </div>

      <div v-if="selected()">
        <p v-if="selected()?.clonedFrom === 'owner'" class="text-xs text-slate-400">
          Admin permissions cannot be edited.
        </p>
        <template v-else>
          <div class="space-y-2">
            <details
              v-for="[category, perms] in categories()"
              :key="category"
              class="group overflow-hidden rounded-lg border border-slate-800 bg-slate-950/45"
            >
              <summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 text-xs font-semibold uppercase tracking-wide text-slate-300 marker:content-none">
                <span>{{ category }}</span>
                <span class="flex items-center gap-2 text-[11px] font-medium normal-case tracking-normal text-slate-500">
                  {{ perms.length }} permissions
                  <svg class="h-4 w-4 transition-transform group-open:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6" /></svg>
                </span>
              </summary>
              <div class="space-y-1 border-t border-slate-800 px-3 py-2">
                <label
                  v-for="p in perms"
                  :key="p.key"
                  class="flex items-start gap-2 py-1.5 text-xs text-slate-300"
                >
                  <input
                    type="checkbox"
                    class="mt-0.5"
                    :checked="draft.has(p.key)"
                    @change="toggle(p.key, p.nonDelegable)"
                  />
                  <span>
                    <span class="font-mono text-farm-gold">{{ p.key }}</span>
                    <span class="block text-slate-500">{{ p.description }}</span>
                  </span>
                </label>
              </div>
            </details>
          </div>
          <button
            type="button"
            class="mt-4 text-xs font-bold px-3 py-1.5 rounded-lg bg-farm-green/20 text-farm-green hover:bg-farm-green/30 disabled:opacity-50"
            :disabled="saving"
            @click="save"
          >
            {{ saving ? 'Saving…' : 'Save permissions' }}
          </button>
        </template>
        <p v-if="message" class="text-xs text-slate-400 mt-2">{{ message }}</p>
      </div>
    </div>
  </CollapsibleSection>
</template>
