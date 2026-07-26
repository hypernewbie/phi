export interface FeatureTask {
    id: string | number;
    title?: string;
    done?: boolean;
    created?: string;
    done_at?: string;
    related_tasks?: Record<string, FeatureTask[]>;
    [key: string]: any;
}

export interface FeatureProgress<T extends FeatureTask = FeatureTask> {
    task: T;
    subtasks: T[];
    total: number;
    completed: number;
    percent: number;
}

export interface FeatureTimelinePoint {
    date: string;
    filed: number;
    completed: number;
}

export interface FeatureDailyCompletion {
    date: string;
    completed: number;
}

export interface PortfolioTimelinePoint {
    date: string;
    filed: number;
    completed: number;
}

export interface FeatureStats {
    totalFeatures: number;
    completedFeatures: number;
    featurePercent: number;
    totalSubtasks: number;
    completedSubtasks: number;
    subtaskPercent: number;
    velocityWindowDays: number;
    completedInWindow: number;
    velocityPerDay: number;
    remainingFeatures: number;
    estimatedDaysRemaining: number | null;
    projectedCompletionDate: string | null;
    dailyCompletions: FeatureDailyCompletion[];
}

// Vikunja returns a RelatedTaskMap keyed by relation kind. A Feature is a
// regular task whose `subtask` relation contains one or more direct children.
// Keeping this pure lets the UI use native relations without Phi-side state.
export function directSubtasks<T extends FeatureTask>(task: T): T[] {
    const children = task?.related_tasks?.subtask;
    return Array.isArray(children) ? children as T[] : [];
}

export function featureProgress<T extends FeatureTask>(task: T): FeatureProgress<T> {
    const seen = new Set<string>();
    const subtasks = directSubtasks(task).filter(child => {
        if (child?.id == null) return false;
        const key = String(child.id);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    const completed = subtasks.filter(child => child.done).length;
    const total = subtasks.length;
    return {
        task,
        subtasks,
        total,
        completed,
        percent: total === 0 ? 0 : Math.round((completed / total) * 100)
    };
}

export function buildFeatures<T extends FeatureTask>(tasks: T[]): FeatureProgress<T>[] {
    return tasks
        .map(task => featureProgress(task))
        .filter(feature => feature.total > 0);
}

function utcDay(value: string | undefined): string | null {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
}

// A compact burn-up series: counts are cumulative, and points appear only on
// days where a child was filed or completed. `done_at` is current-state data,
// so this intentionally represents created/completed tasks, not a full status
// transition history.
export function featureTimeline<T extends FeatureTask>(subtasks: T[]): FeatureTimelinePoint[] {
    const changes = new Map<string, { filed: number; completed: number }>();
    const add = (date: string | null, key: 'filed' | 'completed') => {
        if (!date) return;
        const change = changes.get(date) || { filed: 0, completed: 0 };
        change[key] += 1;
        changes.set(date, change);
    };

    subtasks.forEach(task => {
        add(utcDay(task.created), 'filed');
        // An undone task may retain a historical done_at in some Vikunja
        // versions; count only currently done tasks.
        if (task.done) add(utcDay(task.done_at), 'completed');
    });

    let filed = 0;
    let completed = 0;
    return [...changes.keys()].sort().map(date => {
        const change = changes.get(date)!;
        filed += change.filed;
        completed += change.completed;
        return { date, filed, completed };
    });
}

function utcDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

// Project-level burn-up for feature parents. Filed is the point a feature was
// created; completed is when that parent was marked done.
export function portfolioTimeline<T extends FeatureTask>(features: FeatureProgress<T>[]): PortfolioTimelinePoint[] {
    const changes = new Map<string, { filed: number; completed: number }>();
    const add = (date: string | null, key: 'filed' | 'completed') => {
        if (!date) return;
        const change = changes.get(date) || { filed: 0, completed: 0 };
        change[key] += 1;
        changes.set(date, change);
    };
    features.forEach(feature => {
        add(utcDay(feature.task.created), 'filed');
        if (feature.task.done) add(utcDay(feature.task.done_at), 'completed');
    });

    let filed = 0;
    let completed = 0;
    return [...changes.keys()].sort().map(date => {
        const change = changes.get(date)!;
        filed += change.filed;
        completed += change.completed;
        return { date, filed, completed };
    });
}

// Calculates portfolio-level feature progress from current Vikunja task state.
// Velocity is an explicit rolling-window average, not a promise: task reopen
// history is not available from Vikunja's current done_at field.
export function featureStats<T extends FeatureTask>(features: FeatureProgress<T>[], now: Date = new Date(), velocityWindowDays: number = 28): FeatureStats {
    const windowDays = Math.max(1, Math.floor(velocityWindowDays));
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const start = new Date(today);
    start.setUTCDate(start.getUTCDate() - (windowDays - 1));
    const dailyCompletions: FeatureDailyCompletion[] = [];
    const dailyByDate = new Map<string, FeatureDailyCompletion>();
    for (let index = 0; index < windowDays; index++) {
        const day = new Date(start);
        day.setUTCDate(start.getUTCDate() + index);
        const point = { date: utcDate(day), completed: 0 };
        dailyCompletions.push(point);
        dailyByDate.set(point.date, point);
    }

    let completedFeatures = 0;
    let totalSubtasks = 0;
    let completedSubtasks = 0;
    features.forEach(feature => {
        totalSubtasks += feature.total;
        completedSubtasks += feature.completed;
        if (!feature.task.done) return;
        completedFeatures += 1;
        const date = utcDay(feature.task.done_at);
        const point = date ? dailyByDate.get(date) : null;
        if (point) point.completed += 1;
    });

    const totalFeatures = features.length;
    const remainingFeatures = totalFeatures - completedFeatures;
    const completedInWindow = dailyCompletions.reduce((total, point) => total + point.completed, 0);
    const velocityPerDay = completedInWindow / windowDays;
    const estimatedDaysRemaining = remainingFeatures === 0
        ? 0
        : velocityPerDay > 0 ? Math.ceil(remainingFeatures / velocityPerDay) : null;
    const projectedCompletionDate = estimatedDaysRemaining == null
        ? null
        : utcDate(new Date(today.getTime() + (estimatedDaysRemaining * 24 * 60 * 60 * 1000)));

    return {
        totalFeatures,
        completedFeatures,
        featurePercent: totalFeatures === 0 ? 0 : Math.round((completedFeatures / totalFeatures) * 100),
        totalSubtasks,
        completedSubtasks,
        subtaskPercent: totalSubtasks === 0 ? 0 : Math.round((completedSubtasks / totalSubtasks) * 100),
        velocityWindowDays: windowDays,
        completedInWindow,
        velocityPerDay,
        remainingFeatures,
        estimatedDaysRemaining,
        projectedCompletionDate,
        dailyCompletions
    };
}
