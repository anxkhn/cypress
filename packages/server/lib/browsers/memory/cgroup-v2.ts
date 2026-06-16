import fs from 'fs-extra'
import os from 'os'
import { parseMemoryStat, availableFromWorkingSet } from './cgroup-util'

const CGROUP_ROOT = '/sys/fs/cgroup'

// Returns the total memory limit from the cgroup v2 unified hierarchy.
// `memory.max` contains the memory limit in bytes, or the literal string `max`
// when the cgroup is unconstrained, in which case we fall back to the total
// system memory.
const getTotalMemoryLimit = async () => {
  const limit = (await fs.readFile(`${CGROUP_ROOT}/memory.max`, 'utf8')).trim()

  return limit === 'max' ? os.totalmem() : Number(limit)
}

// Returns the available memory in bytes from the cgroup v2 unified hierarchy.
const getAvailableMemory = async (totalMemoryLimit: number, log?: { [key: string]: any }) => {
  // retrieve the current memory usage and memory stats from the cgroup
  const [current, rawStats] = await Promise.all([
    fs.readFile(`${CGROUP_ROOT}/memory.current`, 'utf8'),
    fs.readFile(`${CGROUP_ROOT}/memory.stat`, 'utf8'),
  ])

  return availableFromWorkingSet(totalMemoryLimit, Number(current), parseMemoryStat(rawStats).inactive_file, log)
}

export default {
  getTotalMemoryLimit,
  getAvailableMemory,
}
