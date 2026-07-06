" Phi Emerald Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_emerald"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#34d399 gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#34d399
hi IncSearch        guifg=#14141a guibg=#059669
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#34d399 guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#34d399 guibg=#1f1f26  gui=bold
hi Directory        guifg=#059669

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#34d399
hi String           guifg=#a7f3d0
hi Character        guifg=#a7f3d0
hi Number           guifg=#34d399
hi Boolean          guifg=#34d399
hi Float            guifg=#34d399

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#059669

hi Statement        guifg=#34d399 gui=bold
hi Conditional      guifg=#34d399 gui=bold
hi Repeat           guifg=#34d399 gui=bold
hi Label            guifg=#34d399
hi Operator         guifg=#059669
hi Keyword          guifg=#34d399 gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#065f46
hi Include          guifg=#065f46
hi Define           guifg=#065f46
hi Macro            guifg=#065f46
hi PreCondit        guifg=#065f46

hi Type             guifg=#065f46 gui=bold
hi StorageClass     guifg=#065f46
hi Structure        guifg=#065f46
hi Typedef          guifg=#065f46

hi Special          guifg=#34d399
hi SpecialChar      guifg=#a7f3d0
hi Tag              guifg=#059669
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#059669    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#34d399  guibg=#1f1f26  gui=bold
