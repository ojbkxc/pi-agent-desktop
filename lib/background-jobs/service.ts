/**
 * 后台 job 的**服务层**：扩展工具、HTTP 路由与启动清理共用的窄接口。
 *
 * 为什么单独一层：扩展工具拿不到「当前会话 cwd」，只能从 `ExtensionContext` 里取；
 * 路由又需要按 id 查/停；启动时还要结算遗留记录。三处的公共部分都在这里，
 * 上层各自只做参数适配。
 */
import { isJobId, listJobs, readJob, settleOrphanedJobs } from "./store";
import { ensureJobsDir, isJobActive, startBackgroundJob, stopBackgroundJob, stopAllBackgroundJobs, type StartJobRequest } from "./runtime";
import type { BackgroundJob } from "./types";

export interface StartJobFromToolRequest extends Omit<StartJobRequest, "cwd"> {
  /**
   * 会话的 cwd（`ctx.cwd`）。**必须由调用方给**：进程 cwd 是服务目录，
   * 用户在某个项目里说「在项目根跑构建」时会跑错地方。
   */
  cwd: string;
}

export function startJobFromTool(request: StartJobFromToolRequest): { job: BackgroundJob } {
  return startBackgroundJob(request);
}

/** 取一条 job；不存在或 id 形状非法都返回 null（路由据此 404，不做路径拼接）。 */
export function getBackgroundJob(id: string): BackgroundJob | null {
  if (!isJobId(id)) return null;
  return readJob(id);
}

/** 停一条 job；返回终态记录，已结束/不存在返回 null。 */
export function stopJobFromTool(id: string): BackgroundJob | null {
  if (!isJobId(id)) return null;
  return stopBackgroundJob(id);
}

export function listBackgroundJobs(): BackgroundJob[] {
  return listJobs();
}

/**
 * 启动清理：建目录、把上个进程遗留的 `running` 结算成 `interrupted`。
 * 幂等，可由 instrumentation 在每个服务进程启动时调用一次。
 */
export function initBackgroundJobs(): BackgroundJob[] {
  ensureJobsDir();
  return settleOrphanedJobs();
}

export { isJobActive, stopAllBackgroundJobs };
export type { BackgroundJob };