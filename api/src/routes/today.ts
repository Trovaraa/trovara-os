import { Hono } from 'hono'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { gatherExceptions, gatherWorkerTodayTasks } from '../lib/exceptions.js'

export const todayRoutes = new Hono<{ Variables: AppVariables }>()

todayRoutes.use('*', authMiddleware)

todayRoutes.get('/', async (c) => {
  const user = c.get('user')
  const { exceptions, actionList, summary } = await gatherExceptions(user)

  if (user.role === 'field_worker') {
    const myTasksToday = await gatherWorkerTodayTasks(user)
    return c.json({
      role: user.role,
      exceptions,
      actionList,
      summary,
      myTasksToday: myTasksToday.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        dueDate: t.dueDate,
        plotName: t.plotName,
      })),
    })
  }

  return c.json({
    role: user.role,
    exceptions,
    actionList,
    summary,
  })
})
