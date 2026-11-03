/* Shared modal focus trap: Escape handling, Tab cycling, and the
   focus-pull-back that keeps a keyboard user inside an open dialog. Each
   dialog keeps its own markup and styling. */
const FOCUSABLE_SELECTOR = 'button:not(:disabled):not([hidden]), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';
export function trapModalFocus(modal, options = {}) {
    const onKeydown = (event) => {
        if (event.key === 'Escape' && options.onEscape) {
            event.preventDefault();
            event.stopPropagation();
            options.onEscape();
            return;
        }
        if (event.key !== 'Tab')
            return;
        const focusable = Array.from(modal.querySelectorAll(FOCUSABLE_SELECTOR)).filter((element) => !element.closest('.hidden'));
        if (focusable.length === 0) {
            event.preventDefault();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const activeIndex = focusable.indexOf(document.activeElement);
        if (event.shiftKey && activeIndex <= 0) {
            event.preventDefault();
            last.focus({ preventScroll: true });
        }
        else if (!event.shiftKey && activeIndex === focusable.length - 1) {
            event.preventDefault();
            first.focus({ preventScroll: true });
        }
    };
    const onFocusin = (event) => {
        if (options.isOpen && !options.isOpen())
            return;
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
