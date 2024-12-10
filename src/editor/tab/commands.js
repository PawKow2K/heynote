export const newTab = (editor) => ({ state, dispatch }) => {
    editor.element.dispatchEvent(new Event("newTab"))
}