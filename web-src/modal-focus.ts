/* Shared modal focus trap: Escape handling, Tab cycling, and the
   focus-pull-back that keeps a keyboard user inside an open dialog. Each
   dialog keeps its own markup and styling. */

export interface ModalFocusTrapOptions {
    onEscape?: () => void;
    /** Whether the dialog is still open; focus pull-back is skipped when not. */
    isOpen?: () => boolean;
    /** Element to focus when focus escapes the dialog. */
    initialFocus?: () => HTMLElement | null;
}

export interface ModalFocusTrap {
    onKeydown: (event: KeyboardEvent) => void;
    onFocusin: (event: FocusEvent) => void;
    dispose(): void;
}

const FOCUSABLE_SELECTOR =
    'button:not(:disabled):not([hidden]), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

export function trapModalFocus(
    modal: HTMLElement,
    options: ModalFocusTrapOptions = {},
): ModalFocusTrap {
    const onKeydown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape' && options.onEscape) {
            event.preventDefault();
            event.stopPropagation();
            options.onEscape();
            return;
        }
        if (event.key !== 'Tab') return;

        const focusable = Array.from(
            modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        ).filter((element) => !element.closest('.hidden'));
        if (focusable.length === 0) {
            event.preventDefault();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const activeIndex = focusable.indexOf(
            document.activeElement as HTMLElement,
        );
        if (event.shiftKey && activeIndex <= 0) {
            event.preventDefault();
            last.focus({ preventScroll: true });
        } else if (!event.shiftKey && activeIndex === focusable.length - 1) {
            event.preventDefault();
            first.focus({ preventScroll: true });
        }
    };

    const onFocusin = (event: FocusEvent): void => {
        if (options.isOpen && !options.isOpen()) return;
        if (event.target instanceof Node && !modal.contains(event.target)) {
            (options.initialFocus?.() ?? modal).focus({ preventScroll: true });
        }
    };

    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('focusin', onFocusin, true);

    return {
        onKeydown,
        onFocusin,
        dispose() {
            document.removeEventListener('keydown', onKeydown, true);
            document.removeEventListener('focusin', onFocusin, true);
        },
    };
}
