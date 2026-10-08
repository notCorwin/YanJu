import { newChannel, newPersona, type Channel, type Persona, type Settings } from '../types'
import { db } from './database'

export async function createChannel(database = db) {
  const channel = newChannel()
  await database.channels.add(channel)
  return channel
}

export const saveChannel = (channel: Channel, database = db) => database.channels.put(channel)

export async function removeChannel(id: string, database = db) {
  await database.transaction('rw', database.channels, database.settings, async () => {
    await database.channels.delete(id)
    if ((await database.settings.get('app'))?.activeChannelId === id)
      await database.settings.update('app', { activeChannelId: '' })
  })
}

export async function createPersona(database = db) {
  const persona = newPersona()
  await database.personas.add(persona)
  return persona
}

export async function savePersona(persona: Persona, activate = false, database = db) {
  await database.transaction('rw', database.personas, database.settings, async () => {
    await database.personas.put(persona)
    if (activate) await database.settings.update('app', { activePersonaId: persona.id })
  })
}

export async function removePersona(id: string, database = db) {
  await database.transaction('rw', database.personas, database.settings, async () => {
    await database.personas.delete(id)
    if ((await database.settings.get('app'))?.activePersonaId === id)
      await database.settings.update('app', { activePersonaId: '' })
  })
}

export const updateSettings = (patch: Partial<Omit<Settings, 'id'>>, database = db) =>
  database.settings.update('app', patch)
