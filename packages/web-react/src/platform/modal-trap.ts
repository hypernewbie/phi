// Modal focus trap. Owns document listeners; screens pass element refs.
export function isVisible(element: HTMLElement): boolean {
    if (!element.isConnected) return false;
    const bounds = element.getBoundingClientRect();
    return (
        bounds.width > 0 &&
        bounds.height > 0 &&
        bounds.right > 0 &&
        bounds.left < window.innerWidth &&
        bounds.bottom > 0 &&
        bounds.top < window.innerHeight
    );
}

function focusables(modal: HTMLElement): HTMLElement[] {
    return Array.from(
        modal.querySelectorAll<HTMLElement>(
            'button, input, textarea, select, [tabindex="0"]',
        ),
    ).filter(
        (element) =>
            (element as { disabled?: boolean }).disabled !== true &&
            element.closest('[hidden], .hidden') === null &&
            getComputedStyle(element).display !== 'none',
    );
}

export function trapModal(
    modal: HTMLElement,
    initialFocus: HTMLElement,
    onEscape: () => void,
): () => void {
    const onKeydown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onEscape();
        } else if (event.key === 'Tab') {
            event.stopPropagation();
            const controls = focusables(modal);
            const index = controls.indexOf(
                document.activeElement as HTMLElement,
            );
            if (
                (event.shiftKey && index <= 0) ||
                (!event.shiftKey &&
                    (index < 0 || index === controls.length - 1))
            ) {
                event.preventDefault();
                const target = event.shiftKey ? controls.at(-1) : controls[0];
                target?.focus();
            }
        }
    };
    const onFocusin = (event: FocusEvent) => {
        if (
            modal.isConnected &&
            event.target instanceof Node &&
            !modal.contains(event.target)
        ) {
            initialFocus.focus({ preventScroll: true });
        }
    };
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('focusin', onFocusin, true);
    initialFocus.focus({ preventScroll: true });
    return () => {
        document.removeEventListener('keydown', onKeydown, true);
        document.removeEventListener('focusin', onFocusin, true);
    };
}
