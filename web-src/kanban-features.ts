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
