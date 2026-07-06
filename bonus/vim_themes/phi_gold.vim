" Phi Gold Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_gold"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#fef08a gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#fef08a
hi IncSearch        guifg=#14141a guibg=#eab308
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#fef08a guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#fef08a guibg=#1f1f26  gui=bold
hi Directory        guifg=#eab308

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#fef08a
hi String           guifg=#fef9c3
hi Character        guifg=#fef9c3
hi Number           guifg=#fef08a
hi Boolean          guifg=#fef08a
hi Float            guifg=#fef08a

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#eab308

hi Statement        guifg=#fef08a gui=bold
hi Conditional      guifg=#fef08a gui=bold
hi Repeat           guifg=#fef08a gui=bold
hi Label            guifg=#fef08a
hi Operator         guifg=#eab308
hi Keyword          guifg=#fef08a gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#a16207
hi Include          guifg=#a16207
hi Define           guifg=#a16207
hi Macro            guifg=#a16207
hi PreCondit        guifg=#a16207

hi Type             guifg=#a16207 gui=bold
hi StorageClass     guifg=#a16207
hi Structure        guifg=#a16207
hi Typedef          guifg=#a16207

hi Special          guifg=#fef08a
hi SpecialChar      guifg=#fef9c3
hi Tag              guifg=#eab308
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#eab308    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#fef08a  guibg=#1f1f26  gui=bold
